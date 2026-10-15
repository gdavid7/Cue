import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { createOutlookClient } from "@/utils/outlook/client";

vi.mock("@/env", () => ({
  env: {
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    MICROSOFT_TENANT_ID: "common",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  },
}));

const logger = createTestLogger();

describe("Graph mailbox concurrency", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never runs more than four requests at once for one mailbox, across clients", async () => {
    const graph = stubGraphFetch();
    const first = createOutlookClient("mailbox-a-token", logger);
    const second = createOutlookClient("mailbox-a-token", logger);

    const requests = Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? first : second)
        .getClient()
        .api(`/me/messages/message-${index}`)
        .get(),
    );
    await graph.drain();
    await Promise.all(requests);

    expect(graph.maxInFlight("mailbox-a-token")).toBe(4);
    expect(graph.completed).toBe(12);
  });

  it("lets other mailboxes run alongside a busy one", async () => {
    const graph = stubGraphFetch();
    const busy = createOutlookClient("mailbox-a-token", logger);
    const other = createOutlookClient("mailbox-b-token", logger);

    const requests = [
      ...Array.from({ length: 4 }, (_, index) =>
        busy.getClient().api(`/me/messages/a-${index}`).get(),
      ),
      other.getClient().api("/me/messages/b-0").get(),
    ];
    await vi.waitFor(() => expect(graph.inFlight("mailbox-b-token")).toBe(1));
    await graph.drain();
    await Promise.all(requests);
  });

  it("counts each item of a $batch against the mailbox", async () => {
    const graph = stubGraphFetch();
    const client = createOutlookClient("mailbox-a-token", logger);

    const batch = client
      .getClient()
      .api("/$batch")
      .post({
        requests: Array.from({ length: 3 }, (_, index) => ({
          id: String(index),
          method: "GET",
          url: `/me/messages/${index}`,
        })),
      });
    const reads = Array.from({ length: 2 }, (_, index) =>
      client.getClient().api(`/me/messages/read-${index}`).get(),
    );
    await vi.waitFor(() => expect(graph.inFlight("mailbox-a-token")).toBe(2));
    // The batch holds three of the four slots, so only one read may start.
    expect(graph.started).toEqual(["/$batch", "/me/messages/read-0"]);

    await graph.drain();
    await Promise.all([batch, ...reads]);
  });
});

function stubGraphFetch() {
  const inFlightByToken = new Map<string, number>();
  const maxByToken = new Map<string, number>();
  const pending: Array<() => void> = [];
  const started: string[] = [];
  let completed = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const token =
        request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
      started.push(
        new URL(request.url).pathname.replace(/^\/v1\.0/, "") || "/",
      );
      const current = (inFlightByToken.get(token) ?? 0) + 1;
      inFlightByToken.set(token, current);
      maxByToken.set(token, Math.max(maxByToken.get(token) ?? 0, current));
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlightByToken.set(token, (inFlightByToken.get(token) ?? 1) - 1);
      completed++;
      return new Response(JSON.stringify({ id: "message" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  return {
    started,
    get completed() {
      return completed;
    },
    inFlight: (token: string) => inFlightByToken.get(token) ?? 0,
    maxInFlight: (token: string) => maxByToken.get(token) ?? 0,
    // Releases requests one at a time until nothing is left waiting.
    async drain() {
      for (let idle = 0; idle < 5; ) {
        const next = pending.shift();
        if (next) {
          idle = 0;
          next();
        } else {
          idle++;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}
