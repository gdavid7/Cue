import { describe, expect, it } from "vitest";
import type { MetadataChange } from "@inboxzero/mail-core/commands";
import type {
  ClaimedWork,
  MailStore,
} from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

type Provider = "google" | "microsoft";
type Role = "inbox" | "sent" | "draft" | "trash" | "spam";

const session = { accountId: "acc-1", generation: "g1" };

// Outlook files the user's own replies in Sent Items and Drafts, and its
// conversation actions leave them there; Gmail's labels mean every message
// in the conversation is a target.
describe("conversation expansion", () => {
  it.each([
    { change: { kind: "archive" } as MetadataChange, view: null },
    { change: { kind: "trash" } as MetadataChange, view: "trash" as Role },
  ])("on Outlook, $change.kind leaves the user's Sent reply in Sent", async ({
    change,
    view,
  }) => {
    const store = await repliedThreadStore("microsoft");
    await admitAndPrepare(store, "op-1", change, ["m-in", "m-sent"]);

    expect(await targetsOf(store, "op-1")).toEqual(["m-in"]);
    expect(await executableTargetsOf(store, "op-1")).toEqual(["m-in"]);
    expect(await effectiveRoles(store, "m-sent")).toEqual(["sent"]);
    expect(await listed(store, "inbox")).toEqual([]);
    expect(await listed(store, "sent")).toEqual(["c1"]);
    if (view) expect(await listed(store, view)).toEqual(["c1"]);
    await store.close();
  });

  it("on Outlook, leaves a Sent reply found during preparation in Sent", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "microsoft" });
    await syncMessages(store, [
      messagePatch("m-in", "c1", 1000, ["inbox"], "microsoft"),
    ]);
    await admitAndPrepare(
      store,
      "op-1",
      { kind: "archive" },
      ["m-in", "m-sent", "m-draft"],
      [
        messagePatch("m-sent", "c1", 2000, ["sent"], "microsoft"),
        messagePatch("m-draft", "c1", 3000, ["draft"], "microsoft"),
      ],
    );

    expect(await executableTargetsOf(store, "op-1")).toEqual(["m-in"]);
    expect(await effectiveRoles(store, "m-sent")).toEqual(["sent"]);
    expect(await effectiveRoles(store, "m-draft")).toEqual(["draft"]);
    await store.close();
  });

  it("on Outlook, a conversation read opened mid-archive leaves its Sent reply in Sent", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "microsoft" });
    await syncMessages(store, [
      messagePatch("m-in", "c1", 1000, ["inbox"], "microsoft"),
    ]);
    const admission = await store.admitConversations({
      accountId: "acc-1",
      commandId: "op-1",
      conversations: [{ accountId: "acc-1", conversationId: "c1" }],
      change: { kind: "archive" },
      observedRevision: await store.readRevision(),
    });
    expect(admission.status).toBe("preparing");

    const read = await store.applyConversationMembership({
      session,
      page: {
        conversation: { accountId: "acc-1", conversationId: "c1" },
        resolutionId: "open-c1",
        keys: [
          { accountId: "acc-1", messageId: "m-in" },
          { accountId: "acc-1", messageId: "m-sent" },
        ],
        changes: [messagePatch("m-sent", "c1", 2000, ["sent"], "microsoft")],
        nextPage: null,
        evidence: null,
      },
    });

    expect(read.status).toBe("committed");
    expect(await executableTargetsOf(store, "op-1")).toEqual(["m-in"]);
    expect(await effectiveRoles(store, "m-sent")).toEqual(["sent"]);
    await store.close();
  });

  it("on Outlook, leaves Sent alone for a conversation whose membership is already known", async () => {
    const store = await repliedThreadStore("microsoft");
    await admitAndPrepare(store, "op-1", { kind: "archive" }, [
      "m-in",
      "m-sent",
    ]);
    const queued = await store.admitConversations({
      accountId: "acc-1",
      commandId: "op-2",
      conversations: [{ accountId: "acc-1", conversationId: "c1" }],
      change: { kind: "trash" },
      observedRevision: await store.readRevision(),
    });

    expect(queued.status).toBe("queued");
    expect(await targetsOf(store, "op-2")).toEqual(["m-in"]);
    expect(await effectiveRoles(store, "m-sent")).toEqual(["sent"]);
    await store.close();
  });

  it("on Outlook, the undo of an archive moves back only what was archived", async () => {
    const store = await repliedThreadStore("microsoft");
    await admitAndPrepare(store, "op-1", { kind: "archive" }, [
      "m-in",
      "m-sent",
    ]);
    const undo = await store.admitConversations({
      accountId: "acc-1",
      commandId: "undo-1",
      conversations: [{ accountId: "acc-1", conversationId: "c1" }],
      change: { kind: "unarchive" },
      observedRevision: await store.readRevision(),
    });

    expect(undo.status).toBe("queued");
    expect(await targetsOf(store, "undo-1")).toEqual(["m-in"]);
    expect(await effectiveRoles(store, "m-in")).toEqual(["inbox"]);
    expect(await effectiveRoles(store, "m-sent")).toEqual(["sent"]);
    await store.close();
  });

  it("on Outlook, cancelling restores the archived message and leaves Sent as it was", async () => {
    const store = await repliedThreadStore("microsoft");
    await store.admitConversations({
      accountId: "acc-1",
      commandId: "op-1",
      conversations: [{ accountId: "acc-1", conversationId: "c1" }],
      change: { kind: "archive" },
      observedRevision: await store.readRevision(),
    });
    expect(await listed(store, "inbox")).toEqual([]);

    await store.cancelOperation({ accountId: "acc-1", operationId: "op-1" });

    expect(await listed(store, "inbox")).toEqual(["c1"]);
    expect(await effectiveRoles(store, "m-sent")).toEqual(["sent"]);
    await store.close();
  });

  it("on Outlook, still deletes a conversation that is only the user's own mail", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "microsoft" });
    await syncMessages(store, [
      messagePatch("m-sent", "c1", 1000, ["sent"], "microsoft"),
    ]);
    await admitAndPrepare(store, "op-1", { kind: "trash" }, ["m-sent"]);

    expect(await executableTargetsOf(store, "op-1")).toEqual(["m-sent"]);
    expect(await effectiveRoles(store, "m-sent")).toEqual(["trash"]);
    await store.close();
  });

  it("on Outlook, marking a conversation read still covers every message", async () => {
    const store = await repliedThreadStore("microsoft");
    await admitAndPrepare(store, "op-1", { kind: "set_read", read: true }, [
      "m-in",
      "m-sent",
    ]);

    expect(await executableTargetsOf(store, "op-1")).toEqual([
      "m-in",
      "m-sent",
    ]);
    await store.close();
  });

  it.each([
    { kind: "archive" } as MetadataChange,
    { kind: "trash" } as MetadataChange,
  ])("on Gmail, $kind still targets every message in the conversation", async (change) => {
    const store = await repliedThreadStore("google");
    await admitAndPrepare(store, "op-1", change, ["m-in", "m-sent"]);

    expect(await executableTargetsOf(store, "op-1")).toEqual([
      "m-in",
      "m-sent",
    ]);
    await store.close();
  });
});

async function repliedThreadStore(provider: Provider) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({ ...session, provider });
  await syncMessages(store, [
    messagePatch("m-in", "c1", 1000, ["inbox"], provider),
    messagePatch("m-sent", "c1", 2000, ["sent"], provider),
  ]);
  return store;
}

async function syncMessages(store: MailStore, changes: ProviderChange[]) {
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session,
      requestId: "boot",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes,
      requiredHydration: [],
      roundComplete: true,
    },
  });
}

async function admitAndPrepare(
  store: MailStore,
  commandId: string,
  change: MetadataChange,
  membership: string[],
  changes: ProviderChange[] = [],
) {
  const admission = await store.admitConversations({
    accountId: "acc-1",
    commandId,
    conversations: [{ accountId: "acc-1", conversationId: "c1" }],
    change,
    observedRevision: await store.readRevision(),
  });
  expect(admission.status).toBe("preparing");
  const work = await store.claimWork({
    ownerId: "owner",
    nowMs: Date.now(),
    leaseMs: 30_000,
  });
  if (work?.kind !== "prepare") throw new Error("expected preparation work");
  const prepare = work as Extract<ClaimedWork, { kind: "prepare" }>;
  const page = await store.applyPreparationPage({
    accountId: "acc-1",
    commandId,
    attemptId: prepare.attemptId,
    session: prepare.session,
    previousPage: prepare.page,
    page: {
      conversation: { accountId: "acc-1", conversationId: "c1" },
      resolutionId: prepare.resolutionId,
      keys: membership.map((messageId) => ({ accountId: "acc-1", messageId })),
      changes,
      nextPage: null,
      evidence: null,
    },
  });
  expect(page.status).toBe("preparing");
  const queued = await store.finishPreparation({
    accountId: "acc-1",
    commandId,
  });
  expect(queued.status).toBe("queued");
}

async function targetsOf(store: MailStore, operationId: string) {
  return (await store.inspect()).operationTargets
    .filter((target) => target.operationId === operationId)
    .map((target) => target.messageId)
    .sort();
}

// What the server is asked to change: the claimed command's own targets.
async function executableTargetsOf(store: MailStore, operationId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const work = await store.claimWork({
      ownerId: "owner",
      nowMs: Date.now(),
      leaseMs: 30_000,
    });
    if (!work) break;
    if (
      work.kind === "command" &&
      work.operation.key.operationId === operationId &&
      work.operation.intent.kind === "metadata"
    ) {
      return work.operation.intent.targets
        .map((target) => target.messageId)
        .sort();
    }
  }
  throw new Error(`expected ${operationId} to be claimable`);
}

async function effectiveRoles(store: MailStore, messageId: string) {
  const message = (await store.inspect()).messages.find(
    (candidate) => candidate.messageId === messageId,
  );
  return message?.effective.roles;
}

async function listed(store: MailStore, role: Role) {
  const { view } = await store.readMailboxView({
    accountIds: ["acc-1"],
    predicate: { kind: "role", role },
    order: "newest_first",
    pageSize: 25,
    after: null,
  });
  return view.conversations.map(
    (conversation) => conversation.key.conversationId,
  );
}

function messagePatch(
  messageId: string,
  conversationId: string,
  receivedAtMs: number,
  roles: Role[],
  provider: Provider,
): Extract<ProviderChange, { kind: "message_patch" }> {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: { provider, messageId, conversationId, version: "1" },
    fields: {
      subject: conversationId,
      preview: messageId,
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs,
      read: false,
      starred: false,
      folderId: FOLDERS[roles[0] ?? "inbox"],
      inboxSection: null,
      labelIds: provider === "google" ? roles.map(gmailLabel) : [],
      categoryIds: [],
      roles,
      hasAttachments: false,
    },
  };
}

const FOLDERS: Record<Role, string> = {
  inbox: "inbox",
  sent: "sentitems",
  draft: "drafts",
  trash: "deleteditems",
  spam: "junkemail",
};

function gmailLabel(role: Role) {
  return role === "draft" ? "DRAFT" : role.toUpperCase();
}
