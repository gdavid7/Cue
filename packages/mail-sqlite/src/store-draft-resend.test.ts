import { describe, expect, it } from "vitest";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const KEY = { accountId: "acc-1", draftId: "d1" };

describe("draft save resent after a tab handoff", () => {
  it("reports a resent save whose content already landed as saved", async () => {
    const store = await draftStore();
    const first = await store.saveDraft({
      key: KEY,
      expectedRevision: null,
      content: content("<p>Thursday works.</p>"),
    });
    if (first.status !== "saved") throw new Error("expected save");

    // The new owner tab receives the same save the old owner already applied.
    const resent = await store.saveDraft({
      key: KEY,
      expectedRevision: null,
      content: content("<p>Thursday works.</p>"),
    });

    expect(resent).toMatchObject({
      status: "saved",
      draftRevision: first.draftRevision,
    });
    expect(await store.readDraft(KEY)).toMatchObject({
      status: "found",
      draftRevision: first.draftRevision,
    });
    await store.close();
  });

  it("still reports a conflict when another edit landed in between", async () => {
    const store = await draftStore();
    const first = await store.saveDraft({
      key: KEY,
      expectedRevision: null,
      content: content("<p>Thursday works.</p>"),
    });
    if (first.status !== "saved") throw new Error("expected save");
    await store.saveDraft({
      key: KEY,
      expectedRevision: first.draftRevision,
      content: content("<p>Friday instead.</p>"),
    });

    const resent = await store.saveDraft({
      key: KEY,
      expectedRevision: first.draftRevision,
      content: content("<p>Thursday works, see you.</p>"),
    });

    expect(resent.status).toBe("conflict");
    await store.close();
  });

  it("keeps a draft frozen for sending in conflict even with the same content", async () => {
    const store = await draftStore();
    const first = await store.saveDraft({
      key: KEY,
      expectedRevision: null,
      content: content("<p>Thursday works.</p>"),
    });
    if (first.status !== "saved") throw new Error("expected save");
    await store.admitSend({
      commandId: "send-1",
      draft: KEY,
      draftRevision: first.draftRevision,
      replyTo: null,
    });

    const resent = await store.saveDraft({
      key: KEY,
      expectedRevision: null,
      content: content("<p>Thursday works.</p>"),
    });

    expect(resent.status).toBe("conflict");
    await store.close();
  });
});

async function draftStore() {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  return store;
}

function content(editableHtml: string) {
  return {
    to: ["ada@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: Plans",
    editableHtml,
    quotedHtml: "",
  };
}
