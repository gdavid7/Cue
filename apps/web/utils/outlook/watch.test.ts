import type { Client } from "@microsoft/microsoft-graph-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { renewOutlookWatch, watchOutlook } from "@/utils/outlook/watch";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: "https://cue.example.com",
    MICROSOFT_WEBHOOK_CLIENT_STATE: "client-state",
  },
}));

const logger = createTestLogger();
const now = new Date("2026-10-15T06:00:00Z");
const GRAPH_MAX_MESSAGE_SUBSCRIPTION_MINUTES = 10_080;

describe("Outlook subscription lifetime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates subscriptions that outlive several missed daily renewals without exceeding the Graph maximum", async () => {
    const { client, post } = createClient();

    await watchOutlook(client, logger);

    expectLongLivedExpiration(post.mock.calls[0][0].expirationDateTime);
  });

  it("renews subscriptions to the same lifetime", async () => {
    const { client, patch } = createClient();

    await renewOutlookWatch(client, "subscription-id", logger);

    expectLongLivedExpiration(patch.mock.calls[0][0].expirationDateTime);
  });
});

function expectLongLivedExpiration(expirationDateTime: string) {
  const minutes =
    (new Date(expirationDateTime).getTime() - now.getTime()) / 60_000;
  expect(minutes).toBeGreaterThan(6 * 24 * 60);
  expect(minutes).toBeLessThan(GRAPH_MAX_MESSAGE_SUBSCRIPTION_MINUTES);
}

function createClient() {
  const post = vi.fn(async (body: { expirationDateTime: string }) => ({
    id: "subscription-id",
    expirationDateTime: body.expirationDateTime,
  }));
  const patch = vi.fn(async (body: { expirationDateTime: string }) => ({
    id: "subscription-id",
    expirationDateTime: body.expirationDateTime,
  }));
  const client = {
    api: vi.fn(() => ({ post, patch })),
  } as unknown as Client;
  return { client, post, patch };
}
