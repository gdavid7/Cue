import type { ContextCandidate, Person } from "@cue/context";
import { z } from "zod";
import { findIntegration } from "@/utils/mcp/integrations";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import {
  onePerIntegration,
  ownedBySameUser,
} from "@/utils/mcp/user-connections";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

// A slow app shouldn't hold up the panel: its items just don't show.
const SOURCE_TIMEOUT_MS = 8000;
const RESULTS_PER_SOURCE = 10;
const MAX_TEXT = 600;
const ASSIGNMENT_PAST_DAYS = 7;
const ASSIGNMENT_FUTURE_DAYS = 30;
const CANVAS_USER_CACHE_SECONDS = 7 * 24 * 60 * 60;

type Execute = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

type Search = {
  /** The account the app was connected from. */
  emailAccountId: string;
  /** Distinctive words of the thread or query. */
  keywords: string[];
  now: Date;
};

/**
 * Items from the person's connected apps, whichever of their email accounts
 * connected them, that may relate to a thread or a question: files from Drive
 * and OneDrive, assignments from Canvas, messages from Slack. Each app is asked in its own way and turned into candidates the
 * ranker treats like emails and meetings; an app that fails or is slow is
 * left out.
 */
export async function fetchConnectorCandidates({
  emailAccountId,
  keywords,
  logger,
  now = new Date(),
}: Pick<Search, "keywords"> & {
  /** The account being viewed; apps connected from the person's others count. */
  emailAccountId: string;
  logger: Logger;
  now?: Date;
}): Promise<ContextCandidate[]> {
  if (!keywords.length) return [];
  const connections = await prisma.mcpConnection
    .findMany({
      where: {
        isActive: true,
        integration: { name: { in: Object.keys(SOURCES) } },
        ...ownedBySameUser(emailAccountId),
      },
      select: {
        emailAccountId: true,
        integration: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    })
    .catch((error) => {
      logger.warn("Failed to load connected apps", { error });
      return [];
    });

  const results = await Promise.all(
    onePerIntegration(connections, emailAccountId).map(async (connection) => {
      const name = connection.integration.name;
      const source = SOURCES[name];
      const provider = findIntegration(name)?.provider;
      if (!source || !provider || !connection.emailAccountId) return [];
      // The provider knows the connection by the account it was made from.
      const connectionAccountId = connection.emailAccountId;
      const execute: Execute = (tool, args) =>
        getIntegrationProvider(provider.id).executeTool({
          app: provider.app,
          authScheme: provider.authScheme,
          emailAccountId: connectionAccountId,
          tool,
          args,
        });
      try {
        return await withTimeout(
          source(execute, {
            emailAccountId: connectionAccountId,
            keywords,
            now,
          }),
          SOURCE_TIMEOUT_MS,
        );
      } catch (error) {
        logger.warn("Connected app search failed", { app: name, error });
        return [];
      }
    }),
  );
  return results.flat();
}

const SOURCES: Record<
  string,
  (execute: Execute, search: Search) => Promise<ContextCandidate[]>
> = {
  googledrive: searchGoogleDrive,
  one_drive: searchOneDrive,
  canvas: searchCanvas,
  slack: searchSlack,
};

export async function searchGoogleDrive(
  execute: Execute,
  { keywords }: Search,
): Promise<ContextCandidate[]> {
  const terms = keywords
    .map((k) => `fullText contains '${k.replace(/['\\]/g, "\\$&")}'`)
    .join(" or ");
  const data = driveFilesSchema.parse(
    await execute("GOOGLEDRIVE_FIND_FILE", {
      q: `(${terms}) and trashed = false`,
      fields:
        "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))",
      pageSize: RESULTS_PER_SOURCE,
      orderBy: "modifiedTime desc",
    }),
  );
  return data.files
    .filter((file) => !file.mimeType?.endsWith(".folder"))
    .map((file) => ({
      id: `googledrive:${file.id}`,
      kind: "file" as const,
      source: "Google Drive",
      title: file.name,
      text: file.name,
      at: file.modifiedTime ?? new Date(0).toISOString(),
      url: file.webViewLink ?? undefined,
      people: (file.owners ?? []).flatMap((owner) =>
        owner.emailAddress
          ? [
              {
                email: owner.emailAddress,
                name: owner.displayName ?? undefined,
              },
            ]
          : [],
      ),
    }));
}

export async function searchOneDrive(
  execute: Execute,
  { keywords }: Search,
): Promise<ContextCandidate[]> {
  const data = oneDriveItemsSchema.parse(
    await execute("ONE_DRIVE_SEARCH_ITEMS", {
      // Graph search ranks by every word; the top few are distinctive enough.
      q: keywords.slice(0, 3).join(" "),
      top: RESULTS_PER_SOURCE,
    }),
  );
  return data.value
    .filter((item) => !item.folder)
    .map((item) => ({
      id: `one_drive:${item.id}`,
      kind: "file" as const,
      source: "OneDrive",
      title: item.name,
      text: item.name,
      at: item.lastModifiedDateTime ?? new Date(0).toISOString(),
      url: item.webUrl ?? undefined,
      people: personFrom(item.lastModifiedBy?.user),
    }));
}

/**
 * Canvas has no search, so it lists the student's assignments due around
 * now and lets the ranker match them to the thread by topic.
 */
export async function searchCanvas(
  execute: Execute,
  { emailAccountId, now }: Search,
): Promise<ContextCandidate[]> {
  const userId = await canvasUserId(execute, emailAccountId);
  const data = canvasEventsSchema.parse(
    await execute("CANVAS_LIST_CALENDAR_EVENTS_FOR_USER", {
      user_id: userId,
      type: "assignment",
      start_date: isoDate(addDays(now, -ASSIGNMENT_PAST_DAYS)),
      end_date: isoDate(addDays(now, ASSIGNMENT_FUTURE_DAYS)),
    }),
  );
  return data.response_data.map((event) => {
    const description = stripHtml(
      event.assignment?.description ?? event.description ?? "",
    );
    return {
      id: `canvas:${event.id}`,
      kind: "assignment" as const,
      source: event.context_name ?? "Canvas",
      title: event.title,
      text: [event.title, event.context_name, description]
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_TEXT),
      snippet: description.slice(0, 200) || undefined,
      at:
        event.assignment?.due_at ??
        event.end_at ??
        event.start_at ??
        now.toISOString(),
      url: event.html_url ?? event.assignment?.html_url ?? undefined,
      people: [],
    };
  });
}

export async function searchSlack(
  execute: Execute,
  { keywords }: Search,
): Promise<ContextCandidate[]> {
  const data = slackSearchSchema.parse(
    await execute("SLACK_SEARCH_MESSAGES", {
      // Slack matches every word, so two distinctive ones keep it from missing.
      query: keywords.slice(0, 2).join(" "),
      count: RESULTS_PER_SOURCE,
      sort: "timestamp",
    }),
  );
  return (data.messages?.matches ?? []).map((match) => ({
    id: `slack:${match.channel?.id ?? ""}:${match.ts}`,
    kind: "chat" as const,
    source: "Slack",
    title: [
      match.channel?.name ? `#${match.channel.name}` : null,
      match.username,
    ]
      .filter(Boolean)
      .join(" · "),
    text: match.text.slice(0, MAX_TEXT),
    at: new Date(Number(match.ts) * 1000).toISOString(),
    url: match.permalink ?? undefined,
    people: [],
  }));
}

async function canvasUserId(execute: Execute, emailAccountId: string) {
  const key = `canvas-user-id:${emailAccountId}`;
  const cached = await redis.get<number>(key).catch(() => null);
  if (cached) return cached;
  const { response_data } = canvasUserSchema.parse(
    await execute("CANVAS_GET_CURRENT_USER", {}),
  );
  await redis
    .set(key, response_data.id, { ex: CANVAS_USER_CACHE_SECONDS })
    .catch(() => null);
  return response_data.id;
}

function personFrom(
  user: { email?: string | null; displayName?: string | null } | undefined,
): Person[] {
  return user?.email
    ? [{ email: user.email, name: user.displayName ?? undefined }]
    : [];
}

function stripHtml(html: string) {
  return (
    html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      // Tags removed before punctuation leave a space in front of it.
      .replace(/\s+([.,;:!?])/g, "$1")
      .trim()
  );
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Apps return their own API's JSON; only the fields used here are checked.
const driveFilesSchema = z.object({
  files: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mimeType: z.string().nullish(),
      modifiedTime: z.string().nullish(),
      webViewLink: z.string().nullish(),
      owners: z
        .array(
          z.object({
            displayName: z.string().nullish(),
            emailAddress: z.string().nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

const oneDriveItemsSchema = z.object({
  value: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      webUrl: z.string().nullish(),
      lastModifiedDateTime: z.string().nullish(),
      folder: z.unknown().optional(),
      lastModifiedBy: z
        .object({
          user: z
            .object({
              email: z.string().nullish(),
              displayName: z.string().nullish(),
            })
            .optional(),
        })
        .nullish(),
    }),
  ),
});

const canvasUserSchema = z.object({
  response_data: z.object({ id: z.number() }),
});

const canvasEventsSchema = z.object({
  response_data: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      title: z.string(),
      description: z.string().nullish(),
      start_at: z.string().nullish(),
      end_at: z.string().nullish(),
      html_url: z.string().nullish(),
      context_name: z.string().nullish(),
      assignment: z
        .object({
          due_at: z.string().nullish(),
          description: z.string().nullish(),
          html_url: z.string().nullish(),
        })
        .nullish(),
    }),
  ),
});

const slackSearchSchema = z.object({
  messages: z
    .object({
      matches: z.array(
        z.object({
          text: z.string(),
          ts: z.string(),
          username: z.string().nullish(),
          permalink: z.string().nullish(),
          channel: z
            .object({ id: z.string().nullish(), name: z.string().nullish() })
            .nullish(),
        }),
      ),
    })
    .nullish(),
});
