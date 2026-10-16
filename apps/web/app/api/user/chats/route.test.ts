import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

const auth = vi.hoisted(() => ({ userId: "user-1" }));

vi.mock("@/utils/middleware", () => ({
  withAuth:
    (
      _scope: string,
      handler: (request: Request & { auth: { userId: string } }) => unknown,
    ) =>
    (request: Request) =>
      handler(Object.assign(request, { auth: { userId: auth.userId } })),
}));

import { GET } from "./route";

const CHATS = [
  chatRow({
    id: "chat-work",
    userId: "user-1",
    emailAccountId: "account-work",
    email: "me@work.example",
    updatedAt: "2026-10-02T00:00:00.000Z",
  }),
  chatRow({
    id: "chat-home",
    userId: "user-1",
    emailAccountId: "account-home",
    email: "me@home.example",
    disconnectedAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }),
  chatRow({
    id: "chat-stranger",
    userId: "user-2",
    emailAccountId: "account-stranger",
    email: "stranger@example.com",
    updatedAt: "2026-10-03T00:00:00.000Z",
  }),
  chatRow({
    id: "chat-deleted",
    userId: "user-1",
    emailAccountId: "account-work",
    email: "me@work.example",
    deletedAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-04T00:00:00.000Z",
  }),
];

describe("GET /api/user/chats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Applies the route's filter to every user's chats, as the database would.
    prisma.chat.findMany.mockImplementation((async (args: {
      where: {
        deletedAt: null;
        emailAccount: { userId: string };
      };
    }) =>
      CHATS.filter(
        (chat) =>
          chat.emailAccount.userId === args.where.emailAccount.userId &&
          args.where.deletedAt === null &&
          chat.deletedAt === null,
      ).sort(
        (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
      )) as never);
  });

  it("lists every account's chats for the signed-in user, labelled with their account", async () => {
    auth.userId = "user-1";

    const response = await GET(
      new NextRequest("http://localhost/api/user/chats"),
      { params: Promise.resolve({}) } as never,
    );
    const body = await response.json();

    expect(
      body.chats.map(
        (chat: {
          id: string;
          emailAccountId: string;
          email: string;
          disconnected: boolean;
        }) => ({
          id: chat.id,
          emailAccountId: chat.emailAccountId,
          email: chat.email,
          disconnected: chat.disconnected,
        }),
      ),
    ).toEqual([
      {
        id: "chat-work",
        emailAccountId: "account-work",
        email: "me@work.example",
        disconnected: false,
      },
      {
        id: "chat-home",
        emailAccountId: "account-home",
        email: "me@home.example",
        disconnected: true,
      },
    ]);
  });

  it("never lists another user's chats", async () => {
    auth.userId = "user-2";

    const response = await GET(
      new NextRequest("http://localhost/api/user/chats"),
      { params: Promise.resolve({}) } as never,
    );
    const body = await response.json();

    expect(body.chats.map((chat: { id: string }) => chat.id)).toEqual([
      "chat-stranger",
    ]);
  });
});

function chatRow({
  id,
  userId,
  emailAccountId,
  email,
  disconnectedAt = null,
  deletedAt = null,
  updatedAt,
}: {
  id: string;
  userId: string;
  emailAccountId: string;
  email: string;
  disconnectedAt?: string | null;
  deletedAt?: string | null;
  updatedAt: string;
}) {
  return {
    id,
    name: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date(updatedAt),
    deletedAt: deletedAt ? new Date(deletedAt) : null,
    emailAccountId,
    emailAccount: {
      userId,
      email,
      account: {
        disconnectedAt: disconnectedAt ? new Date(disconnectedAt) : null,
      },
    },
  };
}
