import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";
import {
  conversationMessageKey,
  type EffectiveMessage,
} from "@inboxzero/mail-core/query-semantics";
import { expect, it } from "vitest";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const ACCOUNTS = ["a", "b", "c"];
// recomputeTargets writes every message through this kind of upsert, whose
// conflict policy reaches into the triggers it fires.
const UPSERT = `INSERT INTO effective_messages(
    account_id, message_id, conversation_id, subject, preview, from_address, to_json,
    received_at_ms, read, starred, label_ids_json, category_ids_json, roles_json,
    in_inbox, in_sent, in_draft, in_trash, in_spam, has_attachments,
    pending_operation_ids_json, message_key
  ) VALUES (?, ?, ?, 'S', '', 'a@x', '[]', ?, ?, 0, '[]', '[]', '["inbox"]', 1, 0, ?, ?, 0, 0, '[]', ?)
  ON CONFLICT(account_id, message_id) DO UPDATE SET
    conversation_id = excluded.conversation_id, received_at_ms = excluded.received_at_ms,
    read = excluded.read, in_draft = excluded.in_draft, in_trash = excluded.in_trash,
    message_key = excluded.message_key`;

// What the triggers maintain, rebuilt from scratch.
const REBUILT_KEYS = `SELECT account_id, conversation_id, message_key FROM (
    SELECT account_id, conversation_id, message_key,
           ROW_NUMBER() OVER (
             PARTITION BY account_id, conversation_id
             ORDER BY (in_draft = 0 AND in_trash = 0) DESC, received_at_ms DESC, message_id DESC
           ) AS rank
    FROM effective_messages
  )
  WHERE rank = 1 AND message_key IS NOT NULL ORDER BY 1, 2`;
const REBUILT_SHARED = `WITH keys AS (${REBUILT_KEYS})
  SELECT message_key, account_id, conversation_id FROM keys
  WHERE message_key IN (
    SELECT message_key FROM keys GROUP BY message_key HAVING COUNT(DISTINCT account_id) > 1
  )
  ORDER BY 1, 2, 3`;

it("keeps message keys and shared copies equal to a full rebuild through random writes", async () => {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  try {
    for (const accountId of ACCOUNTS)
      await store.ensureAccount({
        accountId,
        provider: "google",
        generation: "g",
      });
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let step = 0; step < 1500; step++) {
      const op = random(10);
      const account = ACCOUNTS[random(ACCOUNTS.length)];
      const message = `m${random(40)}`;
      await driver.write(async (tx) => {
        if (op < 7)
          await tx.execute(UPSERT, [
            account,
            message,
            `c${random(10)}`,
            random(30),
            random(2),
            random(5) === 0 ? 1 : 0,
            random(5) === 0 ? 1 : 0,
            random(6) === 0 ? null : `k${random(6)}`,
          ]);
        else if (op < 9)
          await tx.execute(
            "DELETE FROM effective_messages WHERE account_id = ? AND message_id = ?",
            [account, message],
          );
        else if (random(20) === 0)
          await tx.execute(
            "DELETE FROM effective_messages WHERE account_id = ?",
            [account],
          );
        else
          await tx.execute(
            "UPDATE effective_messages SET read = 1 - read WHERE account_id = ? AND message_id = ?",
            [account, message],
          );
      });
      if (step % 50 === 0) await expectRebuilt(driver);
    }
    await expectRebuilt(driver);
  } finally {
    await store.close();
  }
}, 120_000);

it("keys each conversation as mail-core's conversationMessageKey does", async () => {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  try {
    for (const accountId of ACCOUNTS)
      await store.ensureAccount({
        accountId,
        provider: "google",
        generation: "g",
      });
    let seed = 11;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    // Raw headers in the forms providers give, normalised as the store does
    // at every write.
    const forms = (n: number) =>
      [`<k${n}@x>`, `K${n}@X`, ` <k${n}@x> `, `<<k${n}@x>>`][random(4)];
    const written = new Map<string, EffectiveMessage>();
    for (let step = 0; step < 600; step++) {
      const accountId = ACCOUNTS[random(ACCOUNTS.length)];
      const messageId = `m${random(60)}`;
      const raw = random(6) === 0 ? undefined : forms(random(5));
      const draft = random(5) === 0;
      const trash = random(5) === 0;
      const message = {
        accountId,
        messageId,
        conversationId: `c${random(8)}`,
        receivedAtMs: random(20),
        internetMessageId: raw,
        roles: draft ? ["draft"] : trash ? ["trash"] : ["inbox"],
      } as EffectiveMessage;
      written.set(`${accountId}\t${messageId}`, message);
      await driver.write((tx) =>
        tx.execute(UPSERT, [
          accountId,
          messageId,
          message.conversationId,
          message.receivedAtMs,
          0,
          draft ? 1 : 0,
          trash ? 1 : 0,
          normalizeInternetMessageId(raw),
        ]),
      );
    }

    const stored = await driver.read((tx) =>
      tx.query(
        "SELECT account_id, conversation_id, message_key FROM conversation_message_keys",
      ),
    );
    const byConversation = new Map<string, EffectiveMessage[]>();
    for (const message of written.values()) {
      const key = `${message.accountId}\t${message.conversationId}`;
      byConversation.set(key, [...(byConversation.get(key) ?? []), message]);
    }
    const expected = [...byConversation]
      .flatMap(([key, messages]) => {
        const messageKey = conversationMessageKey(messages);
        return messageKey ? [`${key}\t${messageKey}`] : [];
      })
      .sort();
    expect(
      stored
        .map(
          (row) =>
            `${row.account_id}\t${row.conversation_id}\t${row.message_key}`,
        )
        .sort(),
    ).toEqual(expected);
  } finally {
    await store.close();
  }
});

async function expectRebuilt(driver: SqliteDriver) {
  const [keys, rebuiltKeys, shared, rebuiltShared] = await driver.read(
    async (tx) => [
      await tx.query(
        "SELECT account_id, conversation_id, message_key FROM conversation_message_keys ORDER BY 1, 2",
      ),
      await tx.query(REBUILT_KEYS),
      await tx.query(
        "SELECT message_key, account_id, conversation_id FROM shared_message_copies ORDER BY 1, 2, 3",
      ),
      await tx.query(REBUILT_SHARED),
    ],
  );
  expect(keys).toEqual(rebuiltKeys);
  expect(shared).toEqual(rebuiltShared);
}
