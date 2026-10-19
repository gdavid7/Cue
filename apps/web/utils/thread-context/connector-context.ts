import { createHash } from "node:crypto";
import type { ContextCandidate, Person } from "@cue/context";
import { z } from "zod";
import { connectionExecutor } from "@/utils/mcp/provider-connection";
import {
  AppToolError,
  ConnectionExpiredError,
} from "@/utils/mcp/providers/types";
import { parseUrl } from "@/utils/thread-context/linked-pages";
import { onePerIntegration } from "@/utils/mcp/user-connections";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

// A slow app shouldn't hold up the panel: its items just don't show.
const SOURCE_TIMEOUT_MS = 8000;
// An app that keeps failing or timing out usually does so again: an
// assistant turn can search several times in a minute, and each would
// otherwise wait seconds for the same error before answering. One failure
// may be a blip, so it takes this many in a row.
const FAILED_SOURCE_COOLDOWN_SECONDS = 5 * 60;
const FAILURES_BEFORE_COOLDOWN = 2;
// Fetching one known item should be quick; a slow one is left out.
const LOOKUP_TIMEOUT_MS = 5000;
const LINKS_PER_APP = 3;
const JIRA_SITE = /^[a-z0-9-]+\.atlassian\.net$/;
const JIRA_TENANT_TIMEOUT_MS = 2000;
const JIRA_CLOUD_ID_CACHE_SECONDS = 30 * 24 * 60 * 60;
// A reconnect to another HubSpot portal or Salesforce org is rare; a week
// bounds how long a link could point at the old one.
const CONNECTION_DETAIL_CACHE_SECONDS = 7 * 24 * 60 * 60;
// An org's own My Domain host, e.g. acme.my.salesforce.com, not login hosts.
// Salesforce's userinfo names the org's domain in urls.custom_domain; its
// OAuth token response calls the org instance_url.
const SALESFORCE_ORG_FIELDS = ["custom_domain", "instance_url"];
const SALESFORCE_ORG_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.my\.salesforce\.com$/;
const RESULTS_PER_SOURCE = 10;
const MAX_TEXT = 600;
const ASSIGNMENT_PAST_DAYS = 7;
const ASSIGNMENT_FUTURE_DAYS = 30;
const CANVAS_USER_CACHE_SECONDS = 7 * 24 * 60 * 60;
// Enrollments change at term boundaries; a few hours is fresh enough.
const CANVAS_COURSES_CACHE_SECONDS = 6 * 60 * 60;
// Canvas accepts at most 10 context codes per calendar request.
const CANVAS_MAX_CONTEXT_CODES = 10;
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

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

type SenderLookup = {
  now: Date;
  /**
   * The connection and when it last changed, which keys its cached details:
   * a reconnect, perhaps to another account, updates the connection, so
   * details of the account connected before are never reused.
   */
  connectionId: string;
  logger: Logger;
};

/** What a thread points at directly, read from its links and headers. */
export type ThreadSignals = {
  /** Each link with the message it is in, which vouches for it or doesn't. */
  links: { url: string; messageId: string }[];
  /** The latest sender other than the user, unless automated; lowercase. */
  senderEmail?: string;
};

/**
 * Items from the person's connected apps, whichever of their email accounts
 * connected them, that may relate to a thread or a question: files from Drive
 * and OneDrive, assignments from Canvas, messages from Slack. Each app is asked in its own way and turned into candidates the
 * ranker treats like emails and meetings; an app that fails or is slow is
 * left out, and `complete` is false so the result is not kept.
 *
 * Given a thread's `signals`, the items it points at are fetched too: files,
 * issues and tasks it links to, and the sender's record in a CRM.
 */
export async function fetchConnectorCandidates({
  emailAccountId,
  keywords,
  signals = { links: [] },
  logger,
  now = new Date(),
}: Pick<Search, "keywords"> & {
  /** The account being viewed; apps connected from the person's others count. */
  emailAccountId: string;
  signals?: ThreadSignals;
  logger: Logger;
  now?: Date;
}): Promise<{ candidates: ContextCandidate[]; complete: boolean }> {
  const links = signals.links.flatMap((link) => {
    const url = parseUrl(link.url);
    return url ? [{ url, messageId: link.messageId }] : [];
  });
  const apps = new Set([
    ...(keywords.length ? Object.keys(SOURCES) : []),
    ...(links.length ? Object.keys(LINK_SOURCES) : []),
    ...(signals.senderEmail ? Object.keys(SENDER_SOURCES) : []),
  ]);
  if (!apps.size) return { candidates: [], complete: true };
  let complete = true;
  const connections = await prisma.mcpConnection
    .findMany({
      where: {
        isActive: true,
        // The app turned its credentials away: asking again only waits on
        // the same refusal until the person reconnects.
        needsReconnectAt: null,
        integration: { name: { in: [...apps] } },
        ...ownedBySameUser(emailAccountId),
      },
      select: {
        id: true,
        updatedAt: true,
        emailAccountId: true,
        integration: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    })
    .catch((error) => {
      logger.warn("Failed to load connected apps", { error });
      complete = false;
      return [];
    });

  const results = await Promise.all(
    onePerIntegration(connections, emailAccountId).map(async (connection) => {
      const name = connection.integration.name;
      if (!apps.has(name) || !connection.emailAccountId) return [];
      // The provider knows the connection by the account it was made from.
      const connectionAccountId = connection.emailAccountId;
      const execute: Execute | null = connectionExecutor({
        id: connection.id,
        integrationName: name,
        emailAccountId: connectionAccountId,
      });
      if (!execute) return [];
      const search = async (): Promise<ContextCandidate[]> => {
        const source = SOURCES[name];
        if (!source || !keywords.length) return [];
        const failuresKey = `connector-search-failures:${connection.id}`;
        const failures =
          Number(await redis.get<number>(failuresKey).catch(() => 0)) || 0;
        if (failures >= FAILURES_BEFORE_COOLDOWN) {
          complete = false;
          return [];
        }
        try {
          const found = await withTimeout(
            source(execute, {
              emailAccountId: connectionAccountId,
              keywords,
              now,
            }),
            SOURCE_TIMEOUT_MS,
          );
          if (failures) await redis.del(failuresKey).catch(() => null);
          return found;
        } catch (error) {
          if (error instanceof TimeoutError) {
            logger.warn("Connected app timed out", { app: name });
          } else if (isAppServerError(error)) {
            logger.trace("Connected app down for search", { app: name });
          } else {
            logger.warn("Connected app search failed", { app: name, error });
          }
          complete = false;
          // Marked for reconnecting, so it isn't asked again anyway
          if (error instanceof ConnectionExpiredError) return [];
          await redis
            .set(failuresKey, failures + 1, {
              ex: FAILED_SOURCE_COOLDOWN_SECONDS,
            })
            .catch(() => null);
          return [];
        }
      };

      // A link to something the person can't open fails on every try, so a
      // failed lookup leaves `complete` alone: otherwise the thread's context
      // would never be kept, and each open would spend mail quota again.
      const lookup = async (
        find: () => Promise<ContextCandidate | null>,
      ): Promise<ContextCandidate[]> => {
        try {
          const item = await withTimeout(find(), LOOKUP_TIMEOUT_MS);
          return item ? [item] : [];
        } catch (error) {
          // The app's error can quote what was asked, e.g. the sender's email.
          logger.warn("Connected app lookup failed", {
            app: name,
            reason: failureReason(error),
          });
          logger.trace("Connected app lookup error", { app: name, error });
          return [];
        }
      };

      const linkSource = LINK_SOURCES[name];
      const linked = linkSource
        ? uniqueBy(
            links.flatMap(({ url, messageId }) => {
              const key = linkSource.match(url);
              return key ? [{ key, url, messageId }] : [];
            }),
            (link) => link.key,
          )
            .slice(0, LINKS_PER_APP)
            .map((link) =>
              lookup(async () => {
                const item = await linkSource.fetch(
                  execute,
                  link.key,
                  link.url,
                  now,
                );
                return item && { ...item, linkedFrom: link.messageId };
              }),
            )
        : [];
      const senderSource = SENDER_SOURCES[name];
      const { senderEmail } = signals;
      const sender =
        senderSource && senderEmail
          ? [
              lookup(() =>
                senderSource(execute, senderEmail, {
                  now,
                  connectionId: `${connection.id}:${connection.updatedAt.getTime()}`,
                  logger,
                }),
              ),
            ]
          : [];

      return (await Promise.all([...linked, ...sender, search()])).flat();
    }),
  );
  // A file the thread links to can also turn up in search; keep the link.
  const candidates = results.flat();
  return {
    candidates: uniqueBy(
      [
        ...candidates.filter((c) => c.linkedBy),
        ...candidates.filter((c) => !c.linkedBy),
      ],
      (c) => c.id,
    ),
    complete,
  };
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

/** Apps whose links name one item, fetched by the key the link holds. */
const LINK_SOURCES: Partial<
  Record<
    string,
    {
      match: (url: URL) => string | null;
      fetch: (
        execute: Execute,
        key: string,
        url: URL,
        now: Date,
      ) => Promise<ContextCandidate | null>;
    }
  >
> = {
  googledrive: { match: driveFileId, fetch: fetchDriveFile },
  jira: { match: jiraIssueKey, fetch: fetchJiraIssue },
  asana: { match: asanaTaskGid, fetch: fetchAsanaTask },
  clickup: { match: clickUpTaskId, fetch: fetchClickUpTask },
};

/** Apps that keep a record of people, looked up by the sender's address. */
const SENDER_SOURCES: Partial<
  Record<
    string,
    (
      execute: Execute,
      email: string,
      context: SenderLookup,
    ) => Promise<ContextCandidate | null>
  >
> = {
  hubspot: findHubSpotContact,
  salesforce: findSalesforceContact,
};

export async function searchGoogleDrive(
  execute: Execute,
  { keywords }: Search,
): Promise<ContextCandidate[]> {
  const terms = keywords
    .map((k) => `fullText contains '${k.replace(/['\\]/g, "\\$&")}'`)
    .join(" or ");
  // Drive refuses to sort a fullText query (it ranks by relevance), so no
  // orderBy; the ranker weighs recency itself.
  const data = parseToolResult(
    "GOOGLEDRIVE_FIND_FILE",
    driveFilesSchema,
    await execute("GOOGLEDRIVE_FIND_FILE", {
      q: `(${terms}) and trashed = false and mimeType != '${DRIVE_FOLDER_MIME_TYPE}'`,
      fields:
        "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))",
      pageSize: RESULTS_PER_SOURCE,
      corpora: "allDrives",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    }),
  );
  return data.files
    .filter((file) => file.mimeType !== DRIVE_FOLDER_MIME_TYPE)
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
  const data = parseToolResult(
    "ONE_DRIVE_SEARCH_ITEMS",
    oneDriveItemsSchema,
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
  const [userId, contextCodes] = await Promise.all([
    canvasUserId(execute, emailAccountId),
    canvasCourseContextCodes(execute, emailAccountId),
  ]);
  // Without context codes Canvas lists only the personal calendar, which has
  // no assignments.
  if (!contextCodes.length) return [];
  const data = parseToolResult(
    "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER",
    canvasEventsSchema,
    await execute("CANVAS_LIST_CALENDAR_EVENTS_FOR_USER", {
      user_id: userId,
      type: "assignment",
      context_codes: contextCodes,
      start_date: isoDate(addDays(now, -ASSIGNMENT_PAST_DAYS)),
      end_date: isoDate(addDays(now, ASSIGNMENT_FUTURE_DAYS)),
    }),
  );
  // One odd event shouldn't hide the rest.
  const events = data.response_data.flatMap((item) => {
    const event = canvasEventSchema.safeParse(item);
    return event.success ? [event.data] : [];
  });
  return events.map((event) => {
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
  const result = await execute("SLACK_SEARCH_MESSAGES", {
    // Slack matches every word, so two distinctive ones keep it from missing.
    query: keywords.slice(0, 2).join(" "),
    count: RESULTS_PER_SOURCE,
    sort: "timestamp",
  });
  // Slack reports a refusal (e.g. missing_scope) in the body, not the status.
  const refusal = slackErrorSchema.safeParse(result);
  if (refusal.success) {
    throw new Error(`SLACK_SEARCH_MESSAGES refused: ${refusal.data.error}`);
  }
  const data = parseToolResult(
    "SLACK_SEARCH_MESSAGES",
    slackSearchSchema,
    result,
  );
  return data.messages.matches.map((match) => ({
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

async function fetchDriveFile(
  execute: Execute,
  fileId: string,
  _url: URL,
  now: Date,
): Promise<ContextCandidate | null> {
  const file = parseToolResult(
    "GOOGLEDRIVE_GET_FILE_METADATA",
    driveFileSchema,
    await execute("GOOGLEDRIVE_GET_FILE_METADATA", {
      fileId,
      fields:
        "id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress)",
      supportsAllDrives: true,
    }),
  );
  if (file.mimeType === DRIVE_FOLDER_MIME_TYPE) return null;
  const owners = (file.owners ?? []).flatMap((owner) =>
    owner.emailAddress
      ? [{ email: owner.emailAddress, name: owner.displayName ?? undefined }]
      : [],
  );
  const details = [
    DRIVE_TYPE_LABEL[file.mimeType ?? ""],
    owners[0]?.name ?? owners[0]?.email,
  ];
  return {
    ...card(file.name, details),
    id: `googledrive:${file.id}`,
    kind: "file",
    source: "Google Drive",
    at: isoTime(file.modifiedTime, now),
    url: file.webViewLink ?? undefined,
    people: owners,
    linkedBy: "url",
  };
}

async function fetchJiraIssue(
  execute: Execute,
  key: string,
  url: URL,
  now: Date,
): Promise<ContextCandidate | null> {
  const issue = parseToolResult(
    "JIRA_GET_ISSUE",
    jiraIssueSchema,
    await execute("JIRA_GET_ISSUE", {
      issue_id_or_key: key,
      fields: ["summary", "status", "assignee", "priority", "updated"],
    }),
  );
  // Jira is connected to one site, and the same key on another site is
  // another issue: anyone can link to their own site with a key the person's
  // site also has. Show the issue only once the linked site is the connected one.
  if (!(await isConnectedJiraSite(issue.self, url.hostname))) return null;
  const { fields } = issue;
  return {
    ...card(`${issue.key} ${fields.summary}`, [
      fields.status?.name,
      fields.assignee?.displayName,
      fields.priority?.name,
    ]),
    id: `jira:${issue.key}`,
    kind: "task",
    source: "Jira",
    at: isoTime(fields.updated, now),
    url: `${url.origin}/browse/${issue.key}`,
    people: personFrom({
      email: fields.assignee?.emailAddress,
      displayName: fields.assignee?.displayName,
    }),
    linkedBy: "url",
  };
}

async function fetchAsanaTask(
  execute: Execute,
  gid: string,
  url: URL,
  now: Date,
): Promise<ContextCandidate | null> {
  const { data: task } = parseToolResult(
    "ASANA_GET_A_TASK",
    asanaTaskSchema,
    await execute("ASANA_GET_A_TASK", {
      task_gid: gid,
      opt_fields: [
        "name",
        "completed",
        "due_on",
        "assignee.name",
        "permalink_url",
        "modified_at",
      ],
    }),
  );
  const state = task.completed
    ? "Completed"
    : task.due_on
      ? `Due ${task.due_on}`
      : undefined;
  return {
    ...card(task.name, [state, task.assignee?.name]),
    id: `asana:${task.gid}`,
    kind: "task",
    source: "Asana",
    at: isoTime(task.modified_at, now),
    url: task.permalink_url ?? url.href,
    people: [],
    linkedBy: "url",
  };
}

async function fetchClickUpTask(
  execute: Execute,
  taskId: string,
  url: URL,
  now: Date,
): Promise<ContextCandidate | null> {
  const task = parseToolResult(
    "CLICKUP_GET_TASK",
    clickUpTaskSchema,
    await execute("CLICKUP_GET_TASK", { task_id: taskId }),
  );
  const assignees = task.assignees ?? [];
  return {
    ...card(task.name, [task.status?.status, assignees[0]?.username]),
    id: `clickup:${task.id}`,
    kind: "task",
    source: "ClickUp",
    // ClickUp times are milliseconds since the epoch, as strings.
    at: isoTime(task.date_updated ? Number(task.date_updated) : undefined, now),
    url: task.url ?? url.href,
    people: assignees.flatMap((assignee) =>
      personFrom({ email: assignee.email, displayName: assignee.username }),
    ),
    linkedBy: "url",
  };
}

async function findHubSpotContact(
  execute: Execute,
  email: string,
  lookup: SenderLookup,
): Promise<ContextCandidate | null> {
  const [{ results }, portalId] = await Promise.all([
    searchHubSpotContacts(execute, email),
    cachedForConnection(
      `hubspot-portal-id:${lookup.connectionId}`,
      lookup,
      () => hubSpotPortalId(execute),
    ),
  ]);
  const contact = results.find(
    (result) => result.properties.email?.toLowerCase() === email,
  );
  if (!contact) return null;
  const p = contact.properties;
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ") || email;
  return {
    ...card(name, [p.jobtitle, p.company, p.lifecyclestage]),
    id: `hubspot:${contact.id}`,
    kind: "contact",
    source: "HubSpot",
    at: isoTime(p.lastmodifieddate, lookup.now),
    // 0-1 is HubSpot's object type id for contacts.
    url: portalId
      ? `https://app.hubspot.com/contacts/${portalId}/record/0-1/${encodeURIComponent(contact.id)}`
      : undefined,
    people: [{ email, name }],
    linkedBy: "sender",
  };
}

async function searchHubSpotContacts(execute: Execute, email: string) {
  return parseToolResult(
    "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
    hubSpotContactsSchema,
    await execute("HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA", {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
      ],
      properties: [
        "email",
        "firstname",
        "lastname",
        "jobtitle",
        "company",
        "lifecyclestage",
        "lastmodifieddate",
      ],
      limit: 1,
    }),
  );
}

/** The HubSpot account (portal) the connection belongs to. */
async function hubSpotPortalId(execute: Execute): Promise<string | null> {
  const account = parseToolResult(
    "HUBSPOT_GET_ACCOUNT_INFO",
    hubSpotAccountSchema,
    await execute("HUBSPOT_GET_ACCOUNT_INFO", {}),
  );
  const id = String(account.hub_id ?? account.hubId ?? account.portalId ?? "");
  return /^\d+$/.test(id) ? id : null;
}

/** The sender's Salesforce contact, or else their lead. */
async function findSalesforceContact(
  execute: Execute,
  email: string,
  lookup: SenderLookup,
): Promise<ContextCandidate | null> {
  const instance = cachedForConnection(
    `salesforce-instance:${lookup.connectionId}`,
    lookup,
    () => salesforceInstance(execute),
  );
  // Salesforce matches emails partially, so only an exact one counts.
  const exact = (records: SalesforcePerson[]) =>
    records.find((record) => record.Email?.toLowerCase() === email);
  const search = async (tool: string) =>
    exact(
      parseToolResult(
        tool,
        salesforcePeopleSchema,
        await execute(tool, { email, limit: 5 }),
      ).records,
    );

  const contact = await search("SALESFORCE_SEARCH_CONTACTS");
  const lead = contact ? undefined : await search("SALESFORCE_SEARCH_LEADS");
  const person = contact ?? lead;
  if (!person) return null;
  const name = person.Name || email;
  const origin = await instance;
  return {
    ...card(name, [
      person.Title,
      person.Account?.Name ?? person.Company,
      lead && (person.Status ? `Lead: ${person.Status}` : "Lead"),
    ]),
    id: `salesforce:${person.Id}`,
    kind: "contact",
    source: "Salesforce",
    at: isoTime(person.LastModifiedDate, lookup.now),
    url: origin
      ? `${origin}/lightning/r/${lead ? "Lead" : "Contact"}/${encodeURIComponent(person.Id)}/view`
      : undefined,
    people: [{ email, name }],
    linkedBy: "sender",
  };
}

/** `docs.google.com/<type>/d/<id>/…`, `drive.google.com/file/d/<id>/…`, `drive.google.com/open?id=<id>`. */
function driveFileId(url: URL): string | null {
  if (url.hostname !== "docs.google.com" && url.hostname !== "drive.google.com")
    return null;
  // A published copy (`/d/e/…`) has an id of its own that Drive can't fetch.
  const inPath = /\/d\/([\w-]{20,})(?:\/|$)/.exec(url.pathname)?.[1];
  if (inPath) return inPath;
  const inQuery = url.searchParams.get("id");
  return url.hostname === "drive.google.com" &&
    url.pathname === "/open" &&
    inQuery &&
    /^[\w-]{20,}$/.test(inQuery)
    ? inQuery
    : null;
}

/**
 * Whether an issue the connection returned lives on `site`. A connection made
 * with an API key answers from the site itself; one made with OAuth answers
 * through api.atlassian.com under the site's cloud id, which the site
 * publishes. Anything that can't be confirmed counts as another site.
 */
async function isConnectedJiraSite(
  self: string | null | undefined,
  site: string,
): Promise<boolean> {
  const issueUrl = self ? parseUrl(self) : null;
  if (!issueUrl) return false;
  if (issueUrl.hostname === site) return true;
  const cloudId =
    issueUrl.hostname === "api.atlassian.com"
      ? /^\/ex\/jira\/([0-9a-f-]+)\//i.exec(issueUrl.pathname)?.[1]
      : undefined;
  return !!cloudId && cloudId === (await jiraCloudId(site));
}

/** The cloud id Atlassian publishes for a site, cached since it never changes. */
async function jiraCloudId(site: string): Promise<string | null> {
  if (!JIRA_SITE.test(site)) return null;
  // Hashed: the site comes from a link in the user's mail (RD-3).
  const key = `jira-cloud-id:${createHash("sha256").update(site).digest("hex")}`;
  const cached = await redis.get<string>(key).catch(() => null);
  if (cached) return cached;
  const response = await fetch(`https://${site}/_edge/tenant_info`, {
    redirect: "error",
    signal: AbortSignal.timeout(JIRA_TENANT_TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return null;
  const parsed = jiraTenantSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success) return null;
  await redis
    .set(key, parsed.data.cloudId, { ex: JIRA_CLOUD_ID_CACHE_SECONDS })
    .catch(() => null);
  return parsed.data.cloudId;
}

/** `https://<site>.atlassian.net/browse/KEY-123`. */
function jiraIssueKey(url: URL): string | null {
  if (url.protocol !== "https:" || url.port || !JIRA_SITE.test(url.hostname))
    return null;
  return /^\/browse\/([A-Z][A-Z0-9_]+-\d+)\/?$/.exec(url.pathname)?.[1] ?? null;
}

/** `app.asana.com/0/<project>/<task>` and `app.asana.com/1/<workspace>/…/task/<task>`. */
function asanaTaskGid(url: URL): string | null {
  if (url.hostname !== "app.asana.com") return null;
  return (
    /^\/0\/\d+\/(\d+)(?:\/f)?\/?$/.exec(url.pathname)?.[1] ??
    /^\/1\/\d+\/(?:[a-z]+\/\d+\/)*task\/(\d+)(?:\/f)?\/?$/.exec(
      url.pathname,
    )?.[1] ??
    null
  );
}

/**
 * `app.clickup.com/t/<id>`. Custom ids (`/t/<workspace>/DEV-12`) are left
 * out: fetching one needs options the allowlisted tool may not take.
 */
function clickUpTaskId(url: URL): string | null {
  if (url.hostname !== "app.clickup.com") return null;
  return /^\/t\/([a-z0-9]+)\/?$/.exec(url.pathname)?.[1] ?? null;
}

/** A card's title, and its details as one line under it. */
function card(title: string, details: (string | null | undefined)[]) {
  const line = details.filter(Boolean).join(" · ");
  return {
    title,
    text: [title, line].filter(Boolean).join("\n").slice(0, MAX_TEXT),
    snippet: line || undefined,
  };
}

/**
 * A detail of the connected account that doesn't change, such as the HubSpot
 * portal, fetched once per connection. It only adds a link, so a failure
 * just leaves the link off and is tried again next time.
 */
async function cachedForConnection(
  key: string,
  { logger }: SenderLookup,
  fetch: () => Promise<string | null>,
): Promise<string | null> {
  const cached = await redis.get<string>(key).catch(() => null);
  if (cached) return String(cached);
  try {
    const value = await fetch();
    if (value) {
      await redis
        .set(key, value, { ex: CONNECTION_DETAIL_CACHE_SECONDS })
        .catch(() => null);
    }
    return value;
  } catch (error) {
    logger.trace("Connected account detail unavailable", { key, error });
    return null;
  }
}

/**
 * The origin of the person's Salesforce org, e.g. `https://acme.my.salesforce.com`.
 * Composio documents only that the answer describes the user, so any https
 * address it gives on the org's own Salesforce host counts; login hosts and
 * other domains never do.
 */
async function salesforceInstance(execute: Execute): Promise<string | null> {
  const info = await execute("SALESFORCE_GET_USER_INFO", {});
  // Fields that name the org itself come first; any other address after.
  const named = SALESFORCE_ORG_FIELDS.flatMap((field) =>
    stringsIn(info, 0, field),
  );
  for (const value of [...named, ...stringsIn(info)]) {
    const url = parseUrl(value);
    if (
      url?.protocol === "https:" &&
      !url.port &&
      SALESFORCE_ORG_HOST.test(url.hostname)
    ) {
      return url.origin;
    }
  }
  return null;
}

/** The strings in a response, or only those under the key `only`. */
function stringsIn(value: unknown, depth = 0, only?: string): string[] {
  if (typeof value === "string") return only ? [] : [value];
  if (!value || typeof value !== "object" || depth > 4) return [];
  return Object.entries(value).flatMap(([key, v]) =>
    only && key === only && typeof v === "string"
      ? [v]
      : stringsIn(v, depth + 1, only),
  );
}

function isoTime(value: string | number | null | undefined, fallback: Date) {
  const date = value === null || value === undefined ? null : new Date(value);
  return date && !Number.isNaN(date.getTime())
    ? date.toISOString()
    : fallback.toISOString();
}

function failureReason(error: unknown) {
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof ConnectionExpiredError) return "needs_reconnect";
  if (error instanceof AppToolError) return "app_error";
  return "error";
}

async function canvasUserId(execute: Execute, emailAccountId: string) {
  const key = `canvas-user-id:${emailAccountId}`;
  const cached = await redis.get<number>(key).catch(() => null);
  if (cached) return cached;
  const { response_data } = parseToolResult(
    "CANVAS_GET_CURRENT_USER",
    canvasUserSchema,
    await execute("CANVAS_GET_CURRENT_USER", {}),
  );
  await redis
    .set(key, response_data.id, { ex: CANVAS_USER_CACHE_SECONDS })
    .catch(() => null);
  return response_data.id;
}

/** `course_<id>` for the student's active courses, newest first. */
async function canvasCourseContextCodes(
  execute: Execute,
  emailAccountId: string,
): Promise<string[]> {
  const key = `canvas-course-codes:${emailAccountId}`;
  const cached = await redis.get<string[]>(key).catch(() => null);
  if (cached) return cached;
  const { response_data } = parseToolResult(
    "CANVAS_LIST_COURSES",
    canvasCoursesSchema,
    await execute("CANVAS_LIST_COURSES", { enrollment_state: "active" }),
  );
  const codes = response_data
    .map((course) => course.id)
    .sort((a, b) => b - a)
    .slice(0, CANVAS_MAX_CONTEXT_CODES)
    .map((id) => `course_${id}`);
  await redis
    .set(key, codes, { ex: CANVAS_COURSES_CACHE_SECONDS })
    .catch(() => null);
  return codes;
}

/**
 * Checks an app's answer against the fields used here. A mismatch (an error
 * body, or a wrapper we don't know) fails the source so it is logged, naming
 * only the fields, never the content.
 */
export function parseToolResult<T>(
  tool: string,
  schema: z.ZodType<T>,
  data: unknown,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const fields = [
    ...new Set(
      result.error.issues.map((issue) => issue.path.join(".") || "(root)"),
    ),
  ];
  throw new Error(
    `${tool} returned an unexpected response: ${fields.join(", ")}`,
  );
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

/**
 * The app answered with its own server failure (Canvas's
 * `internal_server_error`): nothing on this side can fix it, so the source is
 * left out without a warning.
 */
export function isAppServerError(error: unknown) {
  return (
    error instanceof AppToolError &&
    error.message.includes("internal_server_error")
  );
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(`Timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export class TimeoutError extends Error {}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

const driveFileSchema = driveFilesSchema.shape.files.element;

const DRIVE_TYPE_LABEL: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.form": "Google Form",
  "application/pdf": "PDF",
};

const jiraIssueSchema = z.object({
  key: z.string(),
  self: z.string().nullish(),
  fields: z.object({
    summary: z.string(),
    updated: z.string().nullish(),
    status: z.object({ name: z.string().nullish() }).nullish(),
    priority: z.object({ name: z.string().nullish() }).nullish(),
    assignee: z
      .object({
        displayName: z.string().nullish(),
        emailAddress: z.string().nullish(),
      })
      .nullish(),
  }),
});

const jiraTenantSchema = z.object({ cloudId: z.string().min(1) });

// Asana wraps every resource in `data`.
const asanaTaskSchema = z.object({
  data: z.object({
    gid: z.string(),
    name: z.string(),
    completed: z.boolean().nullish(),
    due_on: z.string().nullish(),
    modified_at: z.string().nullish(),
    permalink_url: z.string().nullish(),
    assignee: z.object({ name: z.string().nullish() }).nullish(),
  }),
});

const clickUpTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string().nullish(),
  date_updated: z.string().nullish(),
  status: z.object({ status: z.string().nullish() }).nullish(),
  assignees: z
    .array(
      z.object({
        username: z.string().nullish(),
        email: z.string().nullish(),
      }),
    )
    .nullish(),
});

const hubSpotContactsSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      properties: z.object({
        email: z.string().nullish(),
        firstname: z.string().nullish(),
        lastname: z.string().nullish(),
        jobtitle: z.string().nullish(),
        company: z.string().nullish(),
        lifecyclestage: z.string().nullish(),
        lastmodifieddate: z.string().nullish(),
      }),
    }),
  ),
});

// Composio describes the answer only as "email, hubId, user details";
// HubSpot's own token lookup calls the portal `hub_id`.
const hubSpotAccountSchema = z.object({
  hub_id: z.union([z.number(), z.string()]).nullish(),
  hubId: z.union([z.number(), z.string()]).nullish(),
  portalId: z.union([z.number(), z.string()]).nullish(),
});

// Contacts and leads share the fields used here; leads have Company and Status.
const salesforcePersonSchema = z.object({
  Id: z.string(),
  Name: z.string().nullish(),
  Email: z.string().nullish(),
  Title: z.string().nullish(),
  Company: z.string().nullish(),
  Status: z.string().nullish(),
  Account: z.object({ Name: z.string().nullish() }).nullish(),
  LastModifiedDate: z.string().nullish(),
});
type SalesforcePerson = z.infer<typeof salesforcePersonSchema>;

const salesforcePeopleSchema = z.object({
  records: z.array(salesforcePersonSchema),
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

const canvasCoursesSchema = z.object({
  response_data: z.array(z.object({ id: z.number() })),
});

const canvasEventsSchema = z.object({ response_data: z.array(z.unknown()) });

const canvasEventSchema = z.object({
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
});

const slackErrorSchema = z.object({ ok: z.literal(false), error: z.string() });

const slackSearchSchema = z.object({
  messages: z.object({
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
  }),
});
