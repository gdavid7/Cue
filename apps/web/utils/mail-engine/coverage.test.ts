import { describe, expect, it } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { Coverage } from "@inboxzero/mail-core/queries";
import {
  getFirstSyncAccountIds,
  isMetadataCoverageComplete,
  waitForMetadataCoverage,
} from "./coverage";

describe("isMetadataCoverageComplete", () => {
  it("requires at least one complete coverage row", () => {
    expect(isMetadataCoverageComplete([])).toBe(false);
    expect(
      isMetadataCoverageComplete([
        {
          accountId: "acc-1",
          scopeId: "primary",
          metadata: "partial",
          content: "partial",
          indexedContent: "partial",
          lastCompletedSyncAtMs: null,
        },
      ]),
    ).toBe(false);
    expect(
      isMetadataCoverageComplete([
        {
          accountId: "acc-1",
          scopeId: "primary",
          metadata: "complete",
          content: "partial",
          indexedContent: "partial",
          lastCompletedSyncAtMs: 1,
        },
      ]),
    ).toBe(true);
  });
});

describe("getFirstSyncAccountIds", () => {
  it("lists accounts that have never finished a sync in this browser", () => {
    expect(
      getFirstSyncAccountIds(
        ["gmail", "outlook", "work"],
        [
          coverage({ accountId: "gmail", lastCompletedSyncAtMs: 10 }),
          coverage({ accountId: "outlook", lastCompletedSyncAtMs: null }),
        ],
      ),
    ).toEqual(["outlook", "work"]);
  });

  it("treats an account as synced once any of its scopes finished a sync", () => {
    expect(
      getFirstSyncAccountIds(
        ["gmail"],
        [
          coverage({
            accountId: "gmail",
            scopeId: "primary",
            lastCompletedSyncAtMs: null,
          }),
          coverage({
            accountId: "gmail",
            scopeId: "archive",
            lastCompletedSyncAtMs: 10,
          }),
        ],
      ),
    ).toEqual([]);
  });
});

describe("waitForMetadataCoverage", () => {
  it("returns true once diagnostics report complete metadata coverage", async () => {
    let coverage: Array<{
      accountId: string;
      scopeId: string;
      metadata: "partial" | "complete";
      content: "partial";
      indexedContent: "partial";
      lastCompletedSyncAtMs: number | null;
    }> = [];
    const client = {
      getDiagnostics: async () => ({ coverage }),
    } as Pick<MailClient, "getDiagnostics"> as MailClient;
    const abort = new AbortController();
    const waiting = waitForMetadataCoverage(client, "acc-1", abort.signal);
    coverage = [
      {
        accountId: "acc-1",
        scopeId: "primary",
        metadata: "complete",
        content: "partial",
        indexedContent: "partial",
        lastCompletedSyncAtMs: 1,
      },
    ];
    await expect(waiting).resolves.toBe(true);
  });

  it("returns false when aborted before coverage completes", async () => {
    const client = {
      getDiagnostics: async () => ({ coverage: [] }),
    } as Pick<MailClient, "getDiagnostics"> as MailClient;
    const abort = new AbortController();
    const waiting = waitForMetadataCoverage(client, "acc-1", abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBe(false);
  });

  it("returns false when aborted while diagnostics hang", async () => {
    const client = {
      getDiagnostics: () => new Promise(() => undefined),
    } as Pick<MailClient, "getDiagnostics"> as MailClient;
    const abort = new AbortController();
    const waiting = waitForMetadataCoverage(client, "acc-1", abort.signal);
    abort.abort();
    await expect(waiting).resolves.toBe(false);
  });
});

function coverage(
  overrides: Partial<Coverage> & { accountId: string },
): Coverage {
  return {
    scopeId: "primary",
    metadata: "partial",
    content: "not_requested",
    indexedContent: "not_requested",
    lastCompletedSyncAtMs: null,
    ...overrides,
  };
}
