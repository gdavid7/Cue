import { describe, expect, it } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  type MailEngine,
} from "@inboxzero/mail-core/engine";
import type { ConversationKey } from "@inboxzero/mail-core/identities";
import type { ConversationView } from "@inboxzero/mail-core/ports/mail-store";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { QueryHandle } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

type Patch = Extract<ProviderChange, { kind: "message_patch" }>;
type MembershipResult = Awaited<
  ReturnType<MailboxSource["readConversationMembership"]>
>;

const session = { accountId: "acc-1", generation: "g1" };
const thread = { accountId: "acc-1", conversationId: "thread-1" };
const inboxQuery = {
  accountIds: ["acc-1"],
  predicate: { kind: "role" as const, role: "inbox" as const },
  order: "newest_first" as const,
  pageSize: 25,
  after: null,
};
const original = threadPatch("original", 1000, ["inbox"]);
const replies = [
  threadPatch("reply-1", 2000, ["sent"]),
  threadPatch("reply-2", 3000, ["sent"]),
];

describe("opening a conversation a first sync has not fully reached", () => {
  it("fills in older messages the sync has not enumerated yet", async () => {
    const source = firstSyncSource({ firstPage: replies });
    const { engine } = await startFirstSync(source);
    const handle = engine.observeConversation(thread, {
      after: null,
      pageSize: 50,
    });
    await settled(handle);
    expect(messageIds(handle)).toEqual(["reply-1", "reply-2"]);

    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "complete",
    });
    await settled(handle);

    expect(messageIds(handle)).toEqual(["original", "reply-1", "reply-2"]);
    expect(source.membershipReads).toBe(1);
    const inspection = await engine.inspect();
    expect(
      inspection.messages.find((row) => row.messageId === "original")?.effective
        .roles,
    ).toEqual(["inbox"]);
    handle.close();
    await engine.close();
  });

  it("asks the provider for a conversation once, however often it is opened", async () => {
    const source = firstSyncSource({ firstPage: replies });
    const { engine } = await startFirstSync(source);

    await Promise.all([
      engine.ensureConversationMessages(thread),
      engine.ensureConversationMessages(thread),
    ]);
    await engine.ensureConversationMessages(thread);

    expect(source.membershipReads).toBe(1);
    await engine.close();
  });

  it("does not ask the provider once the first sync has covered the mailbox", async () => {
    const source = firstSyncSource({
      firstPage: [original, ...replies],
      finishes: true,
    });
    const { engine } = await startFirstSync(source);

    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "complete",
    });

    expect(source.membershipReads).toBe(0);
    await engine.close();
  });

  it("keeps what sync wrote since the provider answered", async () => {
    const starredReply = threadPatch("reply-1", 2000, ["sent"], "7");
    starredReply.fields.starred = true;
    const source = firstSyncSource({
      firstPage: [starredReply],
      // An older copy of the reply, read before sync starred it.
      membership: [original, threadPatch("reply-1", 2000, ["sent"], "3")],
    });
    const { engine } = await startFirstSync(source);

    await engine.ensureConversationMessages(thread);

    const inspection = await engine.inspect();
    const reply = inspection.messages.find(
      (row) => row.messageId === "reply-1",
    );
    expect(reply?.confirmed.starred).toBe(true);
    expect(
      inspection.messages.some((row) => row.messageId === "original"),
    ).toBe(true);
    await engine.close();
  });

  it("asks again once the provider's pause is over", async () => {
    let paused = true;
    const source = firstSyncSource({
      firstPage: replies,
      async readMembership(answer) {
        if (!paused) return answer();
        paused = false;
        return { status: "paused", retryAfterMs: 5000, reason: "throttled" };
      },
    });
    const clock = { nowMs: 10_000 };
    const { engine } = await startFirstSync(source, { clock });

    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "unavailable",
    });
    await engine.ensureConversationMessages(thread);
    expect(source.membershipReads).toBe(1);

    clock.nowMs += 5000;
    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "complete",
    });
    expect(source.membershipReads).toBe(2);
    await engine.close();
  });

  it("waits a minute before asking again after a failed read", async () => {
    let failing = true;
    const source = firstSyncSource({
      firstPage: replies,
      async readMembership(answer) {
        if (!failing) return answer();
        failing = false;
        throw new Error("network down");
      },
    });
    const clock = { nowMs: 10_000 };
    const { engine } = await startFirstSync(source, { clock });

    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "unavailable",
    });
    clock.nowMs += 30_000;
    await engine.ensureConversationMessages(thread);
    expect(source.membershipReads).toBe(1);

    clock.nowMs += 30_000;
    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "complete",
    });
    expect(source.membershipReads).toBe(2);
    await engine.close();
  });

  it("stops asking about a conversation the provider doesn't have", async () => {
    const source = firstSyncSource({
      firstPage: replies,
      async readMembership() {
        return { status: "ok", value: { status: "not_found" } };
      },
    });
    const clock = { nowMs: 10_000 };
    const { engine } = await startFirstSync(source, { clock });

    await engine.ensureConversationMessages(thread);
    clock.nowMs += 24 * 60 * 60_000;
    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "unavailable",
    });

    expect(source.membershipReads).toBe(1);
    await engine.close();
  });

  it("lets an archive after the fill skip its own membership read", async () => {
    const source = firstSyncSource({ firstPage: replies });
    const { engine } = await startFirstSync(source);
    await engine.ensureConversationMessages(thread);

    const admission = await archive(engine, "archive-1");

    expect(admission.status).toBe("queued");
    await engine.close();
  });

  it("does not count a conversation filled for an account reset meanwhile", async () => {
    let release: () => void = () => undefined;
    let held = true;
    const source = firstSyncSource({
      firstPage: replies,
      async readMembership(answer) {
        if (held) {
          held = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return answer();
      },
    });
    const { engine, store } = await startFirstSync(source);

    const filling = engine.ensureConversationMessages(thread);
    while (source.membershipReads === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await store.ensureAccount({
      accountId: "acc-1",
      generation: "g2",
      provider: "google",
    });
    release();

    await expect(filling).resolves.toEqual({ status: "unavailable" });
    const inspection = await engine.inspect();
    expect(
      inspection.messages.some((row) => row.messageId === "original"),
    ).toBe(false);
    await engine.ensureConversationMessages(thread);
    expect(source.membershipReads).toBe(2);
    await engine.close();
  });

  it("keeps a conversation archived while the fill brings in its inbox message", async () => {
    let release: () => void = () => undefined;
    const source = firstSyncSource({
      firstPage: [...replies, threadPatch("reply-3", 4000, ["inbox"])],
      membership: [
        original,
        ...replies,
        threadPatch("reply-3", 4000, ["inbox"]),
      ],
      async readMembership(answer) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return answer();
      },
    });
    const { engine, store } = await startFirstSync(source);

    const filling = engine.ensureConversationMessages(thread);
    while (source.membershipReads === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const admission = await archive(engine, "archive-1");
    expect(admission.status).toBe("preparing");
    release();
    await filling;

    const inbox = await store.readMailboxView(inboxQuery);
    expect(inbox.view.conversations).toEqual([]);
    await engine.close();
  });

  it("does not bring back a message deleted since the provider read it", async () => {
    const source = firstSyncSource({ firstPage: replies });
    const { engine, store } = await startFirstSync(source);
    await store.applyHydration({
      session,
      requestId: "deleted",
      changes: [
        { kind: "message_deleted", key: replies[1].key, evidence: "gone" },
      ],
      bodies: [],
    });

    await engine.ensureConversationMessages(thread);
    await store.applyHydration({
      session,
      requestId: "late-copy",
      changes: [replies[1]],
      bodies: [],
    });

    expect(await isDeleted(engine, "reply-2")).toBe(true);
    await store.applyHydration({
      session,
      requestId: "restored",
      changes: [threadPatch("reply-2", 3000, ["inbox"], "9")],
      bodies: [],
    });
    expect(await isDeleted(engine, "reply-2")).toBe(false);
    await engine.close();
  });

  it("gives up on a provider read that never answers", async () => {
    const source = firstSyncSource({
      firstPage: replies,
      readMembership: () => new Promise(() => undefined),
    });
    const { engine } = await startFirstSync(source, {
      conversationFetchTimeoutMs: 20,
    });

    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "unavailable",
    });
    await engine.close();
  });

  it("stops filling a conversation of an account being removed", async () => {
    const source = firstSyncSource({
      firstPage: replies,
      readMembership: () => new Promise(() => undefined),
    });
    const { engine } = await startFirstSync(source);

    const filling = engine.ensureConversationMessages(thread);
    while (source.membershipReads === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await engine.purgeAccount("acc-1");

    await expect(filling).resolves.toEqual({ status: "unavailable" });
    await engine.close();
  });

  it("asks the provider for at most two conversations at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const source = firstSyncSource({
      firstPage: replies,
      async readMembership(answer) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return answer();
      },
    });
    const { engine } = await startFirstSync(source);

    const opened = ["a", "b", "c", "d"].map((id) =>
      engine.ensureConversationMessages({
        accountId: "acc-1",
        conversationId: id,
      }),
    );
    while (source.membershipReads < 4) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const release of releases.splice(0)) release();
    }
    await Promise.all(opened);

    expect(maxInFlight).toBe(2);
    await engine.close();
  });

  it("asks again right away for an account purged and added back", async () => {
    let paused = true;
    const source = firstSyncSource({
      firstPage: replies,
      async readMembership(answer) {
        if (!paused) return answer();
        paused = false;
        return { status: "paused", retryAfterMs: 60_000, reason: "throttled" };
      },
    });
    const { engine, store } = await startFirstSync(source);
    await engine.ensureConversationMessages(thread);

    await engine.purgeAccount("acc-1");
    await store.ensureAccount({ ...session, provider: "google" });

    await expect(engine.ensureConversationMessages(thread)).resolves.toEqual({
      status: "complete",
    });
    expect(source.membershipReads).toBe(2);
    await engine.close();
  });
});

async function isDeleted(engine: MailEngine, messageId: string) {
  const inspection = await engine.inspect();
  return inspection.messages.find((row) => row.messageId === messageId)
    ?.deleted;
}

async function archive(engine: MailEngine, commandId: string) {
  return engine.submitConversations({
    accountId: "acc-1",
    commandId,
    conversations: [thread],
    change: { kind: "archive" },
    observedRevision: (await engine.inspect()).revision,
  });
}

async function startFirstSync(
  source: MailboxSource,
  {
    clock = { nowMs: 10_000 },
    conversationFetchTimeoutMs,
  }: { clock?: { nowMs: number }; conversationFetchTimeoutMs?: number } = {},
) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({ ...session, provider: "google" });
  const engine = createMailEngine({
    store,
    source,
    executor: {
      async execute() {
        return { status: "uncertain", receiptId: null };
      },
      async inspect() {
        return { status: "uncertain", receiptId: null };
      },
    },
    runtime: createHostRuntime({ nowMs: () => clock.nowMs }),
    conversationFetchTimeoutMs,
  });
  await engine.requestSync(["acc-1"]);
  await engine.runUntil(Date.now() + 2000);
  return { engine, store };
}

function messageIds(handle: QueryHandle<ConversationView>) {
  return handle
    .getSnapshot()
    .data?.messages.map((message) => message.key.messageId);
}

function settled(handle: QueryHandle<ConversationView>) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const snapshot = handle.getSnapshot();
      if (snapshot.status !== "loading" && !snapshot.refreshing) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = handle.subscribe(check);
    check();
  });
}

/**
 * A first sync whose first page lists `firstPage`; unless it `finishes`, the
 * next page stays throttled, as Gmail's quota pacing holds a large mailbox.
 * Membership reads answer with `membership` in one page, through
 * `readMembership` when a test needs to hold or fail them.
 */
function firstSyncSource(input: {
  firstPage: Patch[];
  membership?: Patch[];
  finishes?: boolean;
  readMembership?: (
    answer: () => MembershipResult,
    conversation: ConversationKey,
  ) => Promise<MembershipResult>;
}): MailboxSource & { membershipReads: number } {
  const membership = input.membership ?? [original, ...replies];
  const source: MailboxSource & { membershipReads: number } = {
    membershipReads: 0,
    async describe() {
      return {
        status: "ok",
        value: {
          strategy: "account_history",
          supportedChanges: ["archive"],
          maxPageSize: 50,
          maxHydrationBatch: 20,
        },
      };
    },
    async discoverScopes() {
      return {
        status: "ok",
        value: {
          scopes: [{ id: "primary", kind: "account", folderId: null }],
          nextPage: null,
        },
      };
    },
    async beginBootstrap() {
      return {
        status: "ok",
        value: {
          bootstrapId: "boot",
          enumerationToken: "page-1",
          catchUpFrom: null,
        },
      };
    },
    async enumerate({ page }) {
      if (page !== "page-1") {
        return { status: "paused", retryAfterMs: 60_000, reason: "throttled" };
      }
      return {
        status: "ok",
        value: {
          bootstrapId: "boot",
          scopeId: "primary",
          changes: input.firstPage,
          requiredHydration: [],
          bodies: [],
          ...(input.finishes
            ? {
                nextPage: null,
                catchUpFrom: {
                  streamId: "primary",
                  generation: "g1",
                  checkpoint: "h2",
                },
              }
            : { nextPage: "page-2", catchUpFrom: null }),
        },
      };
    },
    async readChanges({ position, requestId }) {
      return {
        status: "page",
        page: {
          session,
          requestId,
          from: position,
          to: position,
          changes: [],
          requiredHydration: [],
          roundComplete: true,
        },
      };
    },
    async hydrate() {
      return {
        status: "ok",
        value: { changes: [], bodies: [], unresolved: [] },
      };
    },
    async readConversationMembership({ conversation, resolutionId }) {
      source.membershipReads += 1;
      const answer = (): MembershipResult => ({
        status: "ok",
        value: {
          status: "page",
          page: {
            conversation,
            resolutionId,
            keys: membership.map((patch) => patch.key),
            changes: membership,
            nextPage: null,
            evidence: null,
          },
        },
      });
      return input.readMembership
        ? input.readMembership(answer, conversation)
        : answer();
    },
    async search() {
      return { status: "unsupported" };
    },
    async readAttachment() {
      return { status: "not_found" };
    },
  };
  return source;
}

function threadPatch(
  messageId: string,
  receivedAtMs: number,
  roles: Array<"inbox" | "sent">,
  version = "5",
): Patch {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: {
      provider: "google",
      messageId,
      conversationId: thread.conversationId,
      version,
    },
    fields: {
      subject: "Thread",
      preview: messageId,
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs,
      read: true,
      starred: false,
      folderId: null,
      labelIds: roles.map((role) => role.toUpperCase()),
      categoryIds: [],
      roles,
      hasAttachments: false,
    },
  };
}
