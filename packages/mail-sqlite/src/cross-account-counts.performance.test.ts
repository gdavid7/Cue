import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const ACCOUNTS = ["a", "b", "c"];
const CONVERSATIONS = 30_000;
// One in fifty conversations is a message delivered to every account (a
// list, a team alias); the extra cost grows with these copies, not the
// mailbox. SHARED_EVERY=10 in the environment measures a far heavier mix.
const SHARED_EVERY = Number(process.env.SHARED_EVERY ?? 50);
const RUNS = 9;

// All inboxes counts a message delivered to several accounts once. That must
// cost about what the plain count did, as counts rerun on every change.
it("counts 3 × 30k conversations, copies once, within twice a plain count", async () => {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  try {
    for (const accountId of ACCOUNTS)
      await store.ensureAccount({
        accountId,
        provider: "google",
        generation: "g",
      });
    await driver.write(async (tx) => {
      for (const accountId of ACCOUNTS) {
        for (let i = 0; i < CONVERSATIONS; i++) {
          const key =
            i % SHARED_EVERY === 0 ? `shared-${i}@x` : `${accountId}-${i}@x`;
          await tx.execute(
            `INSERT INTO effective_messages(
               account_id, message_id, conversation_id, subject, preview, from_address, to_json,
               received_at_ms, read, starred, label_ids_json, category_ids_json, roles_json,
               in_inbox, in_sent, in_draft, in_trash, in_spam, has_attachments,
               pending_operation_ids_json, message_key
             ) VALUES (?, ?, ?, 'Subject', '', 'ana@example.com', '[]', ?, ?, 0, '[]', '[]', '["inbox"]',
               1, 0, 0, 0, 0, 0, '[]', ?)`,
            [
              accountId,
              `m-${i}`,
              `c-${i}`,
              1_800_000_000_000 + i,
              i % 3 ? 1 : 0,
              key,
            ],
          );
        }
      }
    });

    const inboxCount = () =>
      store.readMailboxCounts({
        accountIds: ACCOUNTS,
        targets: [
          { id: "inbox", predicate: { kind: "mailbox", mailbox: "inbox" } },
        ],
      });
    let view: Awaited<ReturnType<typeof inboxCount>>["view"] | undefined;
    const collapsed = await median(async () => {
      ({ view } = await inboxCount());
    });
    // With no copies left to look at, the count is the plain one it was.
    await driver.write((tx) => tx.exec("DELETE FROM shared_message_copies"));
    const plain = await median(inboxCount);

    const shared = CONVERSATIONS / SHARED_EVERY;
    expect(view?.counts[0]?.matchingConversations).toBe(
      ACCOUNTS.length * CONVERSATIONS - (ACCOUNTS.length - 1) * shared,
    );
    console.info(
      `3 × ${CONVERSATIONS} conversations: plain count ${plain.toFixed(1)} ms, counting copies once ${collapsed.toFixed(1)} ms`,
    );
    // A few milliseconds of slack for a busy CI machine.
    expect(collapsed).toBeLessThan(plain * 2 + 5);
  } finally {
    await store.close();
  }
}, 120_000);

async function median(run: () => Promise<unknown>) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  return times[Math.floor(RUNS / 2)] ?? 0;
}
