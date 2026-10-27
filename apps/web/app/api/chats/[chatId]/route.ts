import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/utils/prisma";
import { withEmailAccount } from "@/utils/middleware";
import { getLiveStreamId } from "@/utils/chat/active-run";
import { softDeleteChat } from "@/utils/chat/soft-delete";
import { ownedChatWhere } from "@/utils/chat/owned-chat";

export type GetChatResponse = Awaited<ReturnType<typeof getChat>>;
const updateChatSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
});

export const GET = withEmailAccount(
  "chats/detail",
  async (request, { params }) => {
    const { userId } = request.auth;
    const { chatId } = await params;

    if (!chatId) {
      return NextResponse.json(
        { error: "Chat ID is required." },
        { status: 400 },
      );
    }

    const chat = await getChat({ chatId, userId });

    return NextResponse.json(chat);
  },
);

export const PATCH = withEmailAccount(
  "chats/update",
  async (request, { params }) => {
    const { userId } = request.auth;
    const { chatId } = await params;

    if (!chatId) {
      return NextResponse.json(
        { error: "Chat ID is required." },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 },
      );
    }

    const { data, error } = updateChatSchema.safeParse(body);
    if (error) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }

    if (data.name === undefined) {
      return NextResponse.json(
        { error: "At least one field must be provided." },
        { status: 400 },
      );
    }

    const updatedChat = await updateChat({
      chatId,
      userId,
      name: data.name,
    });

    if (!updatedChat) {
      return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    }

    return NextResponse.json(updatedChat);
  },
);

export const DELETE = withEmailAccount(
  "chats/delete",
  async (request, { params }) => {
    const { userId } = request.auth;
    const { chatId } = await params;

    if (!chatId) {
      return NextResponse.json(
        { error: "Chat ID is required." },
        { status: 400 },
      );
    }

    const deleted = await deleteChat({ chatId, userId });
    if (!deleted) {
      return NextResponse.json({ error: "Chat not found." }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  },
);

async function getChat({ chatId, userId }: { chatId: string; userId: string }) {
  const chat = await prisma.chat.findFirst({
    where: {
      ...ownedChatWhere({ chatId, userId }),
      deletedAt: null,
    },
    include: {
      messages: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });
  if (!chat) return chat;

  // A marker older than a run can last belongs to an instance that died
  // before clearing it; the reply it marks will never be saved.
  const activeStreamId = getLiveStreamId(chat);
  return {
    ...chat,
    activeStreamId,
    activeStreamStartedAt: activeStreamId ? chat.activeStreamStartedAt : null,
  };
}

async function updateChat({
  chatId,
  userId,
  name,
}: {
  chatId: string;
  userId: string;
  name?: string;
}) {
  const result = await prisma.chat.updateMany({
    where: {
      ...ownedChatWhere({ chatId, userId }),
      deletedAt: null,
    },
    data: {
      ...(name !== undefined ? { name } : {}),
    },
  });

  if (result.count === 0) return null;

  return prisma.chat.findFirst({
    where: {
      ...ownedChatWhere({ chatId, userId }),
      deletedAt: null,
    },
    include: {
      messages: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });
}

async function deleteChat({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  return softDeleteChat({ chatId, userId });
}
