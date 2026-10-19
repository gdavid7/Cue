import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GMAIL_INFLIGHT_LIMIT,
  GMAIL_INFLIGHT_MAX_WAIT_MS,
  resetGmailInflightState,
  takeGmailInflightStats,
  withGmailInflightSlot,
} from "@/utils/gmail/inflight";
import type { GmailQuotaPriority } from "@/utils/gmail/quota";

const ACCOUNT = "account-inflight";

describe("Gmail in-flight cap", () => {
  beforeEach(() => {
    resetGmailInflightState();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never has more of an account's requests in flight than the cap", async () => {
    const gmail = fakeGmail();

    const calls = Array.from({ length: 40 }, (_, index) =>
      send(gmail, index % 2 ? "interactive" : "sync"),
    );
    await gmail.settleAll();
    await Promise.all(calls);

    expect(gmail.maxInflight()).toBe(GMAIL_INFLIGHT_LIMIT);
    expect(gmail.sent()).toBe(40);
  });

  it("counts each request inside a batch toward the cap", async () => {
    const gmail = fakeGmail();

    const batches = Array.from({ length: 6 }, () =>
      send(gmail, "interactive", 5),
    );
    await gmail.settleAll();
    await Promise.all(batches);

    expect(gmail.maxInflight()).toBe(5);
  });

  it("leaves a person's calls room that sync and background never take", async () => {
    const gmail = fakeGmail();
    const background = Array.from({ length: 20 }, () => send(gmail, "sync"));
    await flush();
    expect(gmail.inflight()).toBe(6);

    const opened = send(gmail, "interactive");
    await flush();
    expect(gmail.inflight()).toBe(7);

    await gmail.settleAll();
    await Promise.all([...background, opened]);
  });

  it("sends a waiting person's call before sync calls that queued earlier", async () => {
    const gmail = fakeGmail();
    const sync = Array.from({ length: 12 }, () => send(gmail, "sync"));
    const interactive = Array.from({ length: 4 }, () =>
      send(gmail, "interactive"),
    );
    await flush();
    // Six sync calls and the two slots kept for people; the rest wait.
    expect(gmail.inflight()).toBe(8);

    // As slots free up, the waiting interactive calls go first.
    gmail.settleOldest(2);
    await flush();
    expect(gmail.inflightBy("interactive")).toBe(4);

    await gmail.settleAll();
    await Promise.all([...sync, ...interactive]);
  });

  it("holds background below sync's share", async () => {
    const gmail = fakeGmail();
    const background = Array.from({ length: 10 }, () =>
      send(gmail, "background"),
    );
    await flush();
    expect(gmail.inflight()).toBe(3);

    const sync = send(gmail, "sync");
    await flush();
    expect(gmail.inflightBy("sync")).toBe(1);

    await gmail.settleAll();
    await Promise.all([...background, sync]);
  });

  it("sends a person's call within its bounded wait even when every slot is stuck", async () => {
    vi.useFakeTimers();
    const gmail = fakeGmail();
    const stuck = Array.from({ length: GMAIL_INFLIGHT_LIMIT }, () =>
      send(gmail, "interactive"),
    );
    await flush();

    const opened = send(gmail, "interactive");
    await vi.advanceTimersByTimeAsync(
      GMAIL_INFLIGHT_MAX_WAIT_MS.interactive - 1,
    );
    expect(gmail.sent()).toBe(GMAIL_INFLIGHT_LIMIT);
    await vi.advanceTimersByTimeAsync(1);
    expect(gmail.sent()).toBe(GMAIL_INFLIGHT_LIMIT + 1);
    expect(takeGmailInflightStats()).toMatchObject({ waits: 1, overCap: 1 });

    await gmail.settleAll();
    await Promise.all([...stuck, opened]);
  });

  it("releases the slot of a call that fails", async () => {
    const failures = Array.from({ length: GMAIL_INFLIGHT_LIMIT * 2 }, () =>
      withGmailInflightSlot(
        { emailAccountId: ACCOUNT, priority: "interactive" },
        async () => {
          throw new Error("Gmail refused");
        },
      ).catch(() => undefined),
    );
    await Promise.all(failures);
    takeGmailInflightStats();

    const gmail = fakeGmail();
    const calls = Array.from({ length: GMAIL_INFLIGHT_LIMIT }, () =>
      send(gmail, "interactive"),
    );
    await flush();
    expect(gmail.inflight()).toBe(GMAIL_INFLIGHT_LIMIT);
    expect(takeGmailInflightStats().waits).toBe(0);

    await gmail.settleAll();
    await Promise.all(calls);
  });

  it("runs a call made while holding a slot without waiting for another", async () => {
    vi.useFakeTimers();
    const gmail = fakeGmail();
    const others = Array.from({ length: GMAIL_INFLIGHT_LIMIT - 1 }, () =>
      send(gmail, "interactive"),
    );

    // A batch whose send makes another batch call while every slot is taken.
    const nested = withGmailInflightSlot(
      { emailAccountId: ACCOUNT, priority: "interactive" },
      () =>
        withGmailInflightSlot(
          { emailAccountId: ACCOUNT, priority: "sync", weight: 4 },
          async () => "inner",
        ),
    );

    await expect(nested).resolves.toBe("inner");
    expect(takeGmailInflightStats().waits).toBe(0);

    await gmail.settleAll();
    await Promise.all(others);
  });

  it("keeps accounts apart", async () => {
    const gmail = fakeGmail();
    const first = Array.from({ length: GMAIL_INFLIGHT_LIMIT }, () =>
      send(gmail, "interactive"),
    );
    const second = withGmailInflightSlot(
      { emailAccountId: "account-other", priority: "interactive" },
      async () => "sent",
    );

    await expect(second).resolves.toBe("sent");
    await gmail.settleAll();
    await Promise.all(first);
  });
});

function send(
  gmail: ReturnType<typeof fakeGmail>,
  priority: GmailQuotaPriority,
  weight = 1,
) {
  return withGmailInflightSlot(
    { emailAccountId: ACCOUNT, priority, weight },
    () => gmail.request(priority, weight),
  );
}

/** Requests that stay in flight until the test settles them. */
function fakeGmail() {
  const pending: {
    priority: GmailQuotaPriority;
    weight: number;
    settle: () => void;
  }[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let sent = 0;
  const settle = (count: number) => {
    for (const request of pending.splice(0, count)) request.settle();
  };
  return {
    request(priority: GmailQuotaPriority, weight: number) {
      sent += 1;
      inflight += weight;
      maxInflight = Math.max(maxInflight, inflight);
      return new Promise<void>((resolve) => {
        pending.push({
          priority,
          weight,
          settle: () => {
            inflight -= weight;
            resolve();
          },
        });
      });
    },
    settleOldest: settle,
    async settleAll() {
      while (true) {
        await flush();
        if (pending.length === 0) return;
        settle(pending.length);
      }
    },
    inflight: () => inflight,
    inflightBy: (priority: GmailQuotaPriority) =>
      pending
        .filter((request) => request.priority === priority)
        .reduce((total, request) => total + request.weight, 0),
    maxInflight: () => maxInflight,
    sent: () => sent,
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
