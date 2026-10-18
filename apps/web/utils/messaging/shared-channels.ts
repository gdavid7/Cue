import type {
  MessagingProvider,
  MessagingRoutePurpose,
  MessagingRouteTargetType,
} from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";

// Slack, Teams and Telegram belong to the person, not to one mailbox:
// connecting from any of their mailboxes connects all of them. Each mailbox
// keeps its own MessagingChannel row, because per-mailbox state hangs off it
// (where that mailbox's notifications go, its rule actions, its scheduled
// check-ins), so connecting copies the link to the person's other mailboxes
// and disconnecting clears it from all of them. The Slack bot token is
// per workspace and already shared by every row with that teamId.

const SHARED_FIELDS = {
  provider: true,
  teamId: true,
  teamName: true,
  providerUserId: true,
  botUserId: true,
  accessToken: true,
  refreshToken: true,
  expiresAt: true,
} as const;

const ROUTE_FIELDS = {
  purpose: true,
  targetType: true,
  targetId: true,
} as const;

/**
 * Links the person's other mailboxes to a channel they just connected, so it
 * works the same from every mailbox. A mailbox already connected to that
 * workspace as a different user keeps its own link.
 */
export async function shareConnectedChannel({
  channelId,
  logger,
}: {
  channelId: string;
  logger: Logger;
}) {
  const source = await prisma.messagingChannel.findUnique({
    where: { id: channelId },
    select: {
      ...SHARED_FIELDS,
      isConnected: true,
      emailAccountId: true,
      emailAccount: { select: { userId: true } },
      routes: { select: ROUTE_FIELDS },
    },
  });
  if (!source?.isConnected) return;

  const siblings = await prisma.emailAccount.findMany({
    where: {
      userId: source.emailAccount.userId,
      id: { not: source.emailAccountId },
    },
    select: {
      id: true,
      messagingChannels: {
        where: { provider: source.provider, teamId: source.teamId },
        select: {
          id: true,
          isConnected: true,
          providerUserId: true,
          routes: { select: { purpose: true } },
        },
      },
    },
  });

  let shared = 0;
  for (const sibling of siblings) {
    const existing = sibling.messagingChannels[0];
    if (
      existing?.isConnected &&
      existing.providerUserId !== source.providerUserId
    ) {
      continue;
    }
    await linkChannel({
      emailAccountId: sibling.id,
      source,
      existingPurposes: existing?.routes.map((route) => route.purpose) ?? [],
    });
    shared++;
  }

  if (shared > 0) {
    logger.info("Shared messaging channel with the person's other mailboxes", {
      provider: source.provider,
      mailboxes: shared,
    });
  }
}

/**
 * Gives a mailbox every channel the person already connected from another of
 * their mailboxes and it has no row for yet. Used when a mailbox is linked,
 * and by the one-off backfill. It never revives a row that was disconnected.
 */
export async function shareChannelsWithMailbox({
  mailbox: where,
  dryRun = false,
  logger,
}: {
  /** The mailbox, by its id or by its login (`accountId`). */
  mailbox: { id: string } | { accountId: string };
  /** Count what would be shared without writing anything. */
  dryRun?: boolean;
  logger: Logger;
}) {
  const mailbox = await prisma.emailAccount.findUnique({
    where,
    select: {
      id: true,
      userId: true,
      messagingChannels: { select: { provider: true, teamId: true } },
    },
  });
  if (!mailbox) return 0;

  const has = new Set(
    mailbox.messagingChannels.map((channel) =>
      channelKey(channel.provider, channel.teamId),
    ),
  );

  const candidates = await prisma.messagingChannel.findMany({
    where: {
      isConnected: true,
      emailAccount: { userId: mailbox.userId },
      emailAccountId: { not: mailbox.id },
    },
    // The first-connected row is the one the person set up; copy that one.
    orderBy: { createdAt: "asc" },
    select: { ...SHARED_FIELDS, routes: { select: ROUTE_FIELDS } },
  });

  let shared = 0;
  for (const source of candidates) {
    const key = channelKey(source.provider, source.teamId);
    if (has.has(key)) continue;
    has.add(key);
    if (!dryRun) {
      await linkChannel({
        emailAccountId: mailbox.id,
        source,
        existingPurposes: [],
      });
    }
    shared++;
  }

  if (shared > 0 && !dryRun) {
    logger.info("Shared the person's messaging channels with a mailbox", {
      channels: shared,
    });
  }
  return shared;
}

/**
 * The person's rows for the same workspace link as `channelId`: what a
 * disconnect from any mailbox clears. `emailAccountId` must already be
 * authorised for the requester.
 */
export async function findSharedChannelIds({
  channelId,
  emailAccountId,
}: {
  channelId: string;
  emailAccountId: string;
}): Promise<string[] | null> {
  const channel = await prisma.messagingChannel.findUnique({
    where: { id_emailAccountId: { id: channelId, emailAccountId } },
    select: { provider: true, teamId: true, providerUserId: true },
  });
  if (!channel) return null;

  const rows = await prisma.messagingChannel.findMany({
    where: {
      provider: channel.provider,
      teamId: channel.teamId,
      providerUserId: channel.providerUserId,
      ...ownedBySameUser(emailAccountId),
    },
    select: { id: true },
  });
  return [...new Set([channelId, ...rows.map((row) => row.id)])];
}

type SharedChannel = {
  provider: MessagingProvider;
  teamId: string;
  teamName: string | null;
  providerUserId: string | null;
  botUserId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  routes: Array<{
    purpose: MessagingRoutePurpose;
    targetType: MessagingRouteTargetType;
    targetId: string;
  }>;
};

async function linkChannel({
  emailAccountId,
  source,
  existingPurposes,
}: {
  emailAccountId: string;
  source: SharedChannel;
  existingPurposes: MessagingRoutePurpose[];
}) {
  const link = {
    teamName: source.teamName,
    providerUserId: source.providerUserId,
    botUserId: source.botUserId,
    accessToken: source.accessToken,
    refreshToken: source.refreshToken,
    expiresAt: source.expiresAt,
    isConnected: true,
  };
  // Where notifications go stays per mailbox; a newly linked mailbox starts
  // out delivering where the source does.
  const routes = source.routes
    .filter((route) => !existingPurposes.includes(route.purpose))
    .map(({ purpose, targetType, targetId }) => ({
      purpose,
      targetType,
      targetId,
    }));

  await prisma.messagingChannel.upsert({
    where: {
      emailAccountId_provider_teamId: {
        emailAccountId,
        provider: source.provider,
        teamId: source.teamId,
      },
    },
    update: { ...link, routes: { create: routes } },
    create: {
      ...link,
      provider: source.provider,
      teamId: source.teamId,
      emailAccountId,
      routes: { create: routes },
    },
  });
}

function channelKey(provider: MessagingProvider, teamId: string) {
  return `${provider}:${teamId}`;
}
