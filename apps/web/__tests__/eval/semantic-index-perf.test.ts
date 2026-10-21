import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "@inboxzero/mail-sqlite/node";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import { afterAll, describe, expect, test } from "vitest";
import { shouldRunEvalTests } from "@/__tests__/eval/models";
import { createNodeTextEmbedder } from "@/__tests__/eval/semantic-embedder";
import { createSemanticIndex } from "@/utils/mail-engine/semantic-index";
import { SEMANTIC_MODEL } from "@/utils/mail-search/semantic-embedding";

// How long the on-device semantic index takes to build, through the real
// index and store, for 1,000 and 5,000 messages to embed. The mailbox holds
// two accounts, HTML bodies that fill the model's input, and mail the cap
// leaves out: older than a year, and past the newest 5,000. It also times
// the store's share of each batch, which holds the mailbox's one SQLite
// connection. Node runs the browser's WebAssembly build of the runtime on
// one thread, as the browser's worker does. No model calls.
//
// pnpm --filter inbox-zero-ai test-ai eval/semantic-index-perf
// CI: dispatch ai-evals.yml with test_filter=semantic-index-perf

const SIZES = [1000, 5000];
const ACCOUNTS = ["work", "home"];
// Out of the cap's window, and (for 5,000) past its count.
const OLDER_THAN_A_YEAR = 2000;
const PAST_THE_COUNT = 1000;
// The index's rest between batches, which the measured run skips.
const BATCH_SIZE = 8;
const BATCH_REST_MS = 250;
const NOW = Date.UTC(2026, 9, 19);
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT = 25 * 60_000;

const results: {
  messages: number;
  stored: number;
  embedMs: number;
  storeMs: number[];
  searchMs: number;
}[] = [];

describe.runIf(shouldRunEvalTests())("semantic index build time", () => {
  afterAll(() => printReport());

  for (const size of SIZES) {
    test(
      `${size} messages`,
      async () => {
        const { store, stored } = await mailbox(size);
        try {
          // The store's time per batch: the backlog read and the write.
          const storeMs: number[] = [];
          let batchMs = 0;
          const timed: typeof store = Object.create(store);
          timed.readEmbeddingBacklog = async (input) => {
            const at = performance.now();
            const sources = await store.readEmbeddingBacklog(input);
            batchMs = performance.now() - at;
            if (!sources.length) storeMs.push(batchMs);
            return sources;
          };
          timed.writeMessageEmbeddings = async (input) => {
            const at = performance.now();
            await store.writeMessageEmbeddings(input);
            storeMs.push(batchMs + performance.now() - at);
          };
          const index = createSemanticIndex({
            store: timed,
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
              accountId: ACCOUNTS[0],
              text: "the invoice from the contractor about the kitchen",
              limit: 15,
            });
            searches.push(performance.now() - searchedAt);
          }
          results.push({
            messages: size,
            stored,
            embedMs,
            storeMs,
            searchMs: median(searches),
          });
        } finally {
          await store.close();
        }
      },
      TIMEOUT,
    );
  }
});

async function mailbox(size: number) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  const random = seeded(size);
  const pastCount = size === 5000 ? PAST_THE_COUNT : 0;
  const total = size + pastCount + OLDER_THAN_A_YEAR;
  const messages = Array.from({ length: total }, (_, index) => ({
    accountId: ACCOUNTS[index % ACCOUNTS.length],
    id: `m${index}`,
    subject: words(random, 6),
    html: htmlBody(words(random, 220)),
    // Newest first; the last OLDER_THAN_A_YEAR fall out of the window.
    receivedAtMs:
      index < size + pastCount
        ? NOW - index * 60_000
        : NOW - 400 * DAY_MS - index * 60_000,
  }));
  for (const accountId of ACCOUNTS) {
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g1",
    });
    const own = messages.filter((message) => message.accountId === accountId);
    await store.applySyncPage({
      ownerId: "semantic-index-perf",
      page: {
        session: { accountId, generation: "g1" },
        requestId: "bootstrap",
        from: { streamId: "primary", generation: "g1", checkpoint: null },
        to: { streamId: "primary", generation: "g1", checkpoint: "1" },
        changes: own.map(messagePatch),
        requiredHydration: [],
        roundComplete: true,
      },
      bodies: own.map((message) => ({
        key: { accountId, messageId: message.id },
        version: "1",
        text: null,
        html: message.html,
      })),
    });
  }
  return { store, stored: total };
}

function messagePatch(message: {
  accountId: string;
  id: string;
  subject: string;
  html: string;
  receivedAtMs: number;
}): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: message.accountId, messageId: message.id },
    reference: {
      provider: "google",
      messageId: message.id,
      conversationId: message.id,
      version: "1",
    },
    fields: {
      subject: message.subject,
      preview: message.subject,
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

// A newsletter-shaped body: the text sits inside a few kilobytes of markup.
function htmlBody(text: string) {
  const cell = (content: string) =>
    `<td style="padding:12px 24px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#333333">${content}</td>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}table{border-collapse:collapse}.footer{color:#999;font-size:12px}</style></head><body><table role="presentation" width="100%"><tr>${cell(`<img src="https://example.com/logo.png" width="120" alt="">`)}</tr><tr>${cell(`<p>${text}</p>`)}</tr><tr>${cell(`<a href="https://example.com/a" style="color:#1a73e8">View in browser</a> · <a href="https://example.com/b">Unsubscribe</a>`)}</tr><tr><td class="footer">${"&nbsp;".repeat(40)}Example Inc., 1 Example Way</td></tr></table></body></html>`;
}

function printReport() {
  if (!results.length) return;
  const cpu = cpus();
  const lines = [
    "# Semantic index build time",
    "",
    `Model ${SEMANTIC_MODEL.id}, one thread, ${cpu.length} × ${cpu[0]?.model ?? "unknown CPU"}. Two accounts, HTML bodies that fill the model's ${SEMANTIC_MODEL.maxTokens} tokens, and mail the cap leaves out. Wall time adds the index's ${BATCH_REST_MS} ms rest after each batch of ${BATCH_SIZE}. Store time is the backlog read and the write, per batch, which hold the mailbox's SQLite connection.`,
    "",
    "| To embed | In mailbox | Embed and store | Per message | Wall time with rests | Store per batch (median / max) | Store total | Search (median of 5) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      ({ messages, stored, embedMs, storeMs, searchMs }) =>
        `| ${messages} | ${stored} | ${seconds(embedMs)} | ${(embedMs / messages).toFixed(1)} ms | ${seconds(embedMs + Math.ceil(messages / BATCH_SIZE) * BATCH_REST_MS)} | ${median(storeMs).toFixed(1)} / ${Math.max(...storeMs).toFixed(1)} ms | ${seconds(storeMs.reduce((sum, ms) => sum + ms, 0))} | ${searchMs.toFixed(0)} ms |`,
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
