import { NextResponse } from "next/server";
import groupBy from "lodash/groupBy";
import { serializedMatchMetadataSchema } from "@/utils/ai/assistant/chat-context-validation";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import {
  type HistoryAction,
  isHistoryAction,
} from "@/utils/rule/history-action-kinds";
import { historyActionCondition } from "@/utils/rule/history-actions";

const LIMIT = 50;

export type GetExecutedRulesResponse = Awaited<
  ReturnType<typeof getExecutedRules>
>;

export const GET = withEmailAccount(
  "user/executed-rules/history",
  async (request) => {
    const emailAccountId = request.auth.emailAccountId;

    const url = new URL(request.url);
    const requestedPage = Number(url.searchParams.get("page") || "1");
    const page =
      Number.isSafeInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1;
    const threadId = url.searchParams.get("threadId") || undefined;
    const excludeMessageId = threadId
      ? url.searchParams.get("excludeMessageId") || undefined
      : undefined;
    const ruleId = url.searchParams.get("ruleId") || "all";
    const action = url.searchParams.get("action");
    // Today's "While you were away" links here with the window it counted,
    // and only Cue's own runs, so the list matches the count.
    const since = parseDate(url.searchParams.get("since"));
    const until = parseDate(url.searchParams.get("until"));
    const automatedOnly = url.searchParams.get("automated") === "1";

    const result = await getExecutedRules({
      page,
      ruleId,
      emailAccountId,
      threadId,
      excludeMessageId,
      action: isHistoryAction(action) ? action : undefined,
      since,
      until,
      automatedOnly,
    });

    return NextResponse.json(result);
  },
);

async function getExecutedRules({
  page,
  ruleId,
  emailAccountId,
  threadId,
  excludeMessageId,
  action,
  since,
  until,
  automatedOnly,
}: {
  page: number;
  ruleId?: string;
  emailAccountId: string;
  threadId?: string;
  excludeMessageId?: string;
  action?: HistoryAction;
  since?: Date;
  until?: Date;
  automatedOnly?: boolean;
}) {
  const conditions = [Prisma.sql`"emailAccountId" = ${emailAccountId}`];
  if (ruleId === "skipped") {
    conditions.push(
      Prisma.sql`status = ${ExecutedRuleStatus.SKIPPED}::"ExecutedRuleStatus"`,
    );
  } else {
    conditions.push(
      Prisma.sql`status = ${ExecutedRuleStatus.APPLIED}::"ExecutedRuleStatus" AND "ruleId" IS NOT NULL`,
    );
    if (ruleId && ruleId !== "all") {
      conditions.push(Prisma.sql`"ruleId" = ${ruleId}`);
    }
  }
  if (threadId) conditions.push(Prisma.sql`"threadId" = ${threadId}`);
  if (excludeMessageId) {
    conditions.push(Prisma.sql`"messageId" != ${excludeMessageId}`);
  }
  if (action) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ExecutedAction" ea
      WHERE ea."executedRuleId" = "ExecutedRule".id
        AND ${historyActionCondition("ea", [action])}
    )`);
  }
  if (since) conditions.push(Prisma.sql`"createdAt" >= ${since}`);
  if (until) conditions.push(Prisma.sql`"createdAt" < ${until}`);
  if (automatedOnly) conditions.push(Prisma.sql`automated = true`);
  const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
  const groupColumn = threadId
    ? Prisma.sql`"messageId"`
    : Prisma.sql`"threadId"`;

  const [messages, totals] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        threadId: string;
        messageId: string;
        ids: string[];
        messageCount: number;
      }>
    >(Prisma.sql`
      WITH messages AS (
        SELECT "threadId", "messageId", MAX("createdAt") AS "createdAt"
        FROM "ExecutedRule" ${where}
        GROUP BY "threadId", "messageId"
      ), ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY "threadId" ORDER BY "createdAt" DESC, "messageId") AS position,
          (COUNT(*) OVER (PARTITION BY "threadId"))::int AS "messageCount"
        FROM messages
      ), page AS (
        SELECT * FROM ranked
        ${threadId ? Prisma.empty : Prisma.sql`WHERE position = 1`}
        ORDER BY "createdAt" DESC, "threadId", "messageId"
        LIMIT ${LIMIT} OFFSET ${(page - 1) * LIMIT}
      )
      SELECT page."threadId", page."messageId", page."messageCount",
        ARRAY(
          SELECT id FROM "ExecutedRule" ${where}
            AND "threadId" = page."threadId" AND "messageId" = page."messageId"
        ) AS ids
      FROM page
      ORDER BY page."createdAt" DESC, page."threadId", page."messageId"
    `),
    prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
      SELECT COUNT(DISTINCT ${groupColumn}) AS total FROM "ExecutedRule" ${where}
    `),
  ]);

  const executedRules = messages.length
    ? await prisma.executedRule.findMany({
        where: {
          emailAccountId,
          id: { in: messages.flatMap((message) => message.ids) },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        select: {
          id: true,
          messageId: true,
          threadId: true,
          actionItems: true,
          status: true,
          reason: true,
          matchMetadata: true,
          automated: true,
          createdAt: true,
          rule: {
            select: {
              id: true,
              name: true,
              systemType: true,
              instructions: true,
              groupId: true,
              from: true,
              to: true,
              subject: true,
              body: true,
              conditionalOperator: true,
              group: { select: { name: true } },
            },
          },
        },
      })
    : [];

  const executedRulesByMessageId = groupBy(executedRules, (er) => er.messageId);
  const results = messages
    .map(({ messageId, threadId, messageCount }) => ({
      messageId,
      threadId,
      messageCount,
      executedRules: (executedRulesByMessageId[messageId] ?? []).map(
        (executedRule) => ({
          ...executedRule,
          matchMetadata:
            serializedMatchMetadataSchema.safeParse(executedRule.matchMetadata)
              .data ?? null,
        }),
      ),
    }))
    .filter((message) => message.executedRules.length > 0);

  return {
    results,
    totalPages: Math.ceil(Number(totals[0]?.total ?? 0) / LIMIT),
  };
}

function parseDate(value: string | null) {
  if (!value) return;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
