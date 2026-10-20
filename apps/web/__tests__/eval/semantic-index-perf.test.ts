import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import { afterAll, describe, expect, test } from "vitest";
import { shouldRunEvalTests } from "@/__tests__/eval/models";
import { createNodeTextEmbedder } from "@/__tests__/eval/semantic-embedder";
import { createSemanticIndex } from "@/utils/mail-engine/semantic-index";
import { SEMANTIC_MODEL } from "@/utils/mail-search/semantic-embedding";

// How long the on-device semantic index takes to build, through the real
// index and store, for mailboxes of 1,000 and 5,000 messages whose bodies
// fill the model's input. Node runs the browser's WebAssembly build of the
// runtime on one thread, as the browser's worker does. No model calls.
//
// pnpm --filter inbox-zero-ai test-ai eval/semantic-index-perf
// CI: dispatch ai-evals.yml with test_filter=semantic-index-perf

const SIZES = [1000, 5000];
// The index's rest between batches, which the measured run skips.
const BATCH_SIZE = 8;
const BATCH_REST_MS = 250;
const NOW = Date.UTC(2026, 9, 19);
const TIMEOUT = 25 * 60_000;

const results: {
  messages: number;
  embedMs: number;
  searchMs: number;
}[] = [];

describe.runIf(shouldRunEvalTests())("semantic index build time", () => {
  afterAll(() => printReport());

  for (const size of SIZES) {
    test(
      `${size} messages`,
      async () => {
        const store = await mailbox(size);
        try {
          const index = createSemanticIndex({
            store,
            embedder: await createNodeTextEmbedder(),
            nowMs: () => NOW,
            sleep: async () => undefined,
          });
          const startedAt = performance.now();
          expect(await index.indexBacklog()).toBe(size);
          const embedMs = performance.now() - startedAt;
          const searches: number[] = [];
          for (let run = 0; run < 5; run++) {
            const searchedAt = performance.now();
            await index.search({
              accountId: "perf",
              text: "the invoice from the contractor about the kitchen",
              limit: 15,
            });
            searches.push(performance.now() - searchedAt);
          }
          results.push({ messages: size, embedMs, searchMs: median(searches) });
        } finally {
          await store.close();
        }
      },
      TIMEOUT,
    );
  }
});

async function mailbox(size: number): Promise<MailStore> {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: "perf",
    provider: "google",
    generation: "g1",
  });
  const random = seeded(size);
  const messages = Array.from({ length: size }, (_, index) => ({
    id: `m${index}`,
    subject: words(random, 6),
    body: words(random, 220),
    receivedAtMs: NOW - index * 60_000,
  }));
  await store.applySyncPage({
    ownerId: "semantic-index-perf",
    page: {
      session: { accountId: "perf", generation: "g1" },
      requestId: "bootstrap",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: messages.map(messagePatch),
      requiredHydration: [],
      roundComplete: true,
    },
    bodies: messages.map((message) => ({
      key: { accountId: "perf", messageId: message.id },
      version: "1",
      text: message.body,
      html: null,
    })),
  });
  return store;
}

function messagePatch(message: {
  id: string;
  subject: string;
  body: string;
  receivedAtMs: number;
}): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "perf", messageId: message.id },
    reference: {
      provider: "google",
      messageId: message.id,
      conversationId: message.id,
      version: "1",
    },
    fields: {
      subject: message.subject,
      preview: message.body.slice(0, 160),
      from: "Sender <sender@example.com>",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: message.receivedAtMs,
      read: true,
      starred: false,
      folderId: null,
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}

function printReport() {
  if (!results.length) return;
  const cpu = cpus();
  const lines = [
    "# Semantic index build time",
    "",
    `Model ${SEMANTIC_MODEL.id}, one thread, ${cpu.length} × ${cpu[0]?.model ?? "unknown CPU"}. Bodies fill the model's ${SEMANTIC_MODEL.maxTokens} tokens. Wall time adds the index's ${BATCH_REST_MS} ms rest after each batch of ${BATCH_SIZE}.`,
    "",
    "| Messages | Embed and store | Per message | Wall time with rests | Search (median of 5) |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      ({ messages, embedMs, searchMs }) =>
        `| ${messages} | ${seconds(embedMs)} | ${(embedMs / messages).toFixed(1)} ms | ${seconds(embedMs + Math.ceil(messages / BATCH_SIZE) * BATCH_REST_MS)} | ${searchMs.toFixed(0)} ms |`,
    ),
  ];
  const report = lines.join("\n");
  console.log(`\n${report}\n`);
  if (process.env.EVAL_REPORT_PATH) {
    const path = join(
      dirname(process.env.EVAL_REPORT_PATH),
      "semantic-index-perf.md",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${report}\n`);
  }
}

const VOCABULARY =
  "the invoice for the kitchen remodel is attached please review the cabinets counters and lighting before friday our team will schedule the install after the permit arrives thanks for your patience with the delays the budget for next quarter includes travel hotel and conference fees let me know if the meeting moves to thursday afternoon the school trip needs a signed permission slip and the dentist confirmed your cleaning appointment your order has shipped and the tracking number is below the landlord sent a notice about rent and the lease renewal".split(
    " ",
  );

function words(random: () => number, count: number) {
  return Array.from(
    { length: count },
    () => VOCABULARY[Math.floor(random() * VOCABULARY.length)],
  ).join(" ");
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)} s`;
}
