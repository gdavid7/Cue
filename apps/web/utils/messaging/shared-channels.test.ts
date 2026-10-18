import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  MessagingProvider,
  MessagingRoutePurpose,
  MessagingRouteTargetType,
} from "@/generated/prisma/enums";
import {
  findSharedChannelIds,
  shareChannelsWithMailbox,
  shareConnectedChannel,
} from "@/utils/messaging/shared-channels";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";

vi.mock("@/utils/prisma");

const logger = createTestLogger();

const dmRoute = {
  purpose: MessagingRoutePurpose.RULE_NOTIFICATIONS,
  targetType: MessagingRouteTargetType.DIRECT_MESSAGE,
  targetId: "U1",
};

// A team channel chosen for one mailbox's digests.
const teamChannelRoute = {
  purpose: MessagingRoutePurpose.DIGESTS,
  targetType: MessagingRouteTargetType.CHANNEL,
  targetId: "C-team",
};

const slack = {
  provider: MessagingProvider.SLACK,
  teamId: "T1",
  teamName: "Acme",
  providerUserId: "U1",
  botUserId: "B1",
  accessToken: "xoxb-token",
  refreshToken: null,
  expiresAt: null,
};

describe("shareConnectedChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.messagingChannel.findUnique.mockResolvedValue({
      ...slack,
      isConnected: true,
      emailAccountId: "work",
      emailAccount: { userId: "user-1" },
      routes: [dmRoute],
    } as never);
  });

  it("links the person's other mailboxes to the workspace, delivering where the source does", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "personal", messagingChannels: [] },
    ] as never);

    await shareConnectedChannel({ channelId: "channel-work", logger });

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", id: { not: "work" } },
      }),
    );
    expect(prisma.messagingChannel.upsert).toHaveBeenCalledTimes(1);
    const upsert = prisma.messagingChannel.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({
      emailAccountId_provider_teamId: {
        emailAccountId: "personal",
        provider: MessagingProvider.SLACK,
        teamId: "T1",
      },
    });
    expect(upsert.create).toMatchObject({
      emailAccountId: "personal",
      providerUserId: "U1",
      accessToken: "xoxb-token",
      isConnected: true,
      routes: { create: [dmRoute] },
    });
  });

  it("reconnects a mailbox that was disconnected, keeping the destinations it still has", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "personal",
        messagingChannels: [
          {
            id: "channel-personal",
            isConnected: false,
            providerUserId: "U1",
            routes: [{ purpose: MessagingRoutePurpose.RULE_NOTIFICATIONS }],
          },
        ],
      },
    ] as never);

    await shareConnectedChannel({ channelId: "channel-work", logger });

    const upsert = prisma.messagingChannel.upsert.mock.calls[0][0];
    expect(upsert.update).toMatchObject({
      isConnected: true,
      routes: { create: [] },
    });
  });

  it("gives other mailboxes the source's direct messages, never a team channel chosen for the source", async () => {
    prisma.messagingChannel.findUnique.mockResolvedValue({
      ...slack,
      isConnected: true,
      emailAccountId: "work",
      emailAccount: { userId: "user-1" },
      routes: [dmRoute, teamChannelRoute],
    } as never);
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "personal", messagingChannels: [] },
    ] as never);

    await shareConnectedChannel({ channelId: "channel-work", logger });

    const upsert = prisma.messagingChannel.upsert.mock.calls[0][0];
    expect(upsert.create.routes).toEqual({ create: [dmRoute] });
    expect(upsert.update.routes).toEqual({ create: [dmRoute] });
  });

  it("leaves a mailbox connected to the workspace as a different Slack user alone", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "personal",
        messagingChannels: [
          {
            id: "channel-personal",
            isConnected: true,
            providerUserId: "U2",
            routes: [],
          },
        ],
      },
    ] as never);

    await shareConnectedChannel({ channelId: "channel-work", logger });

    expect(prisma.messagingChannel.upsert).not.toHaveBeenCalled();
  });

  it("shares nothing from a disconnected channel", async () => {
    prisma.messagingChannel.findUnique.mockResolvedValue({
      ...slack,
      isConnected: false,
    } as never);

    await shareConnectedChannel({ channelId: "channel-work", logger });

    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.messagingChannel.upsert).not.toHaveBeenCalled();
  });
});

describe("shareChannelsWithMailbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gives a newly linked mailbox the person's channels, once per workspace", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "personal",
      userId: "user-1",
      messagingChannels: [],
    } as never);
    prisma.messagingChannel.findMany.mockResolvedValue([
      { ...slack, routes: [dmRoute] },
      { ...slack, routes: [] },
    ] as never);

    const shared = await shareChannelsWithMailbox({
      mailbox: { accountId: "login-1" },
      logger,
    });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: "login-1" } }),
    );
    expect(prisma.messagingChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isConnected: true,
          emailAccount: { userId: "user-1" },
          emailAccountId: { not: "personal" },
        },
      }),
    );
    expect(shared).toBe(1);
    expect(prisma.messagingChannel.upsert).toHaveBeenCalledTimes(1);
  });

  it("backfills direct messages only, so no mailbox starts posting into a team channel", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "personal",
      userId: "user-1",
      messagingChannels: [],
    } as never);
    prisma.messagingChannel.findMany.mockResolvedValue([
      { ...slack, routes: [teamChannelRoute, dmRoute] },
    ] as never);

    await shareChannelsWithMailbox({ mailbox: { id: "personal" }, logger });

    const upsert = prisma.messagingChannel.upsert.mock.calls[0][0];
    expect(upsert.create.routes).toEqual({ create: [dmRoute] });
  });

  it("never revives a workspace the mailbox already has a row for, even a disconnected one", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "personal",
      userId: "user-1",
      messagingChannels: [{ provider: MessagingProvider.SLACK, teamId: "T1" }],
    } as never);
    prisma.messagingChannel.findMany.mockResolvedValue([
      { ...slack, routes: [dmRoute] },
    ] as never);

    const shared = await shareChannelsWithMailbox({
      mailbox: { id: "personal" },
      logger,
    });

    expect(shared).toBe(0);
    expect(prisma.messagingChannel.upsert).not.toHaveBeenCalled();
  });

  it("counts without writing on a dry run", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "personal",
      userId: "user-1",
      messagingChannels: [],
    } as never);
    prisma.messagingChannel.findMany.mockResolvedValue([
      { ...slack, routes: [dmRoute] },
    ] as never);

    const shared = await shareChannelsWithMailbox({
      mailbox: { id: "personal" },
      dryRun: true,
      logger,
    });

    expect(shared).toBe(1);
    expect(prisma.messagingChannel.upsert).not.toHaveBeenCalled();
  });
});

describe("findSharedChannelIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds the same Slack link on the person's other mailboxes, and only theirs", async () => {
    prisma.messagingChannel.findUnique.mockResolvedValue({
      provider: MessagingProvider.SLACK,
      teamId: "T1",
      providerUserId: "U1",
    } as never);
    prisma.messagingChannel.findMany.mockResolvedValue([
      { id: "channel-work" },
      { id: "channel-personal" },
    ] as never);

    const ids = await findSharedChannelIds({
      channelId: "channel-work",
      emailAccountId: "work",
    });

    expect(prisma.messagingChannel.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id_emailAccountId: { id: "channel-work", emailAccountId: "work" },
        },
      }),
    );
    expect(prisma.messagingChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider: MessagingProvider.SLACK,
          teamId: "T1",
          providerUserId: "U1",
          ...ownedBySameUser("work"),
        },
      }),
    );
    expect(ids).toEqual(["channel-work", "channel-personal"]);
  });

  it("returns null for a channel the mailbox does not hold", async () => {
    prisma.messagingChannel.findUnique.mockResolvedValue(null);

    await expect(
      findSharedChannelIds({ channelId: "other", emailAccountId: "work" }),
    ).resolves.toBeNull();
    expect(prisma.messagingChannel.findMany).not.toHaveBeenCalled();
  });
});
