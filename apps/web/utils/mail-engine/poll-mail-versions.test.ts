/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPolledAccountIds, pollMailVersions } from "./poll-mail-versions";

describe("pollMailVersions", () => {
  let stops: (() => void)[];
  let server: FakeVersionServer;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    stops = [];
    server = new FakeVersionServer({ a: "1", b: "1" });
  });

  afterEach(() => {
    for (const stop of stops) stop();
    vi.useRealTimers();
  });

  function poll(locks?: FakePollLocks, accountIds = ["a", "b"]) {
    const onChanged = vi.fn();
    const stop = pollMailVersions({
      accountIds,
      onChanged,
      locks: locks as unknown as LockManager | undefined,
      fetchVersions: (ids, etag) => server.answer(ids, etag),
    });
    stops.push(stop);
    return { onChanged, stop };
  }

  it("polls as soon as it starts, syncing accounts it has no baseline for", async () => {
    const { onChanged } = poll();
    await flush();

    expect(server.requested).toEqual([["a", "b"]]);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
  });

  it("syncs only the accounts whose version moved, and nothing while a 304 says nothing did", async () => {
    const { onChanged } = poll();
    await flush();
    onChanged.mockClear();

    await minute();
    expect(server.answers.at(-1)).toBe("304");
    expect(onChanged).not.toHaveBeenCalled();

    server.versions.b = "2";
    await minute();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["b"]);

    await minute();
    expect(server.answers.at(-1)).toBe("304");
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("keeps its own baseline when storage is unavailable", async () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      const { onChanged } = poll();
      await flush();
      expect(onChanged).toHaveBeenCalledExactlyOnceWith(["a", "b"]);

      server.versions.a = "2";
      await minute();
      expect(onChanged).toHaveBeenLastCalledWith(["a"]);
      expect(onChanged).toHaveBeenCalledTimes(2);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("leaves accounts another tab is streaming to that stream", async () => {
    const locks = new FakePollLocks(["cue:mail-stream:a"]);
    const { onChanged } = poll(locks);
    await flush();
    expect(server.requested.at(-1)).toEqual(["b"]);

    // The stream lock lets go (that tab went hidden): the poll covers it again.
    locks.streaming.clear();
    await minute();
    expect(server.requested.at(-1)).toEqual(["a", "b"]);
    onChanged.mockClear();
    await minute();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("asks nothing while every account is streamed", async () => {
    const locks = new FakePollLocks(["cue:mail-stream:a", "cue:mail-stream:b"]);
    poll(locks);

    await flush();
    await minute();

    expect(server.requested).toEqual([]);
  });

  it("polls from one tab per browser, and the next takes over at once when it closes", async () => {
    const locks = new FakePollLocks([]);
    const first = poll(locks);
    poll(locks);
    await flush();
    expect(server.requested).toHaveLength(1);

    await minute();
    expect(server.requested).toHaveLength(2);

    first.stop();
    await flush();
    expect(server.requested).toHaveLength(3);
  });

  it("hands its baseline to the next tab, so a change during the handover still syncs", async () => {
    const locks = new FakePollLocks([]);
    const first = poll(locks);
    const second = poll(locks);
    await flush();

    server.versions.a = "2";
    first.stop();
    await flush();

    expect(second.onChanged).toHaveBeenCalledExactlyOnceWith(["a"]);
  });

  it("lets another tab poll while this page sits in the back/forward cache", async () => {
    const locks = new FakePollLocks([]);
    const first = poll(locks);
    const second = poll(locks);
    await flush();
    expect(locks.queued()).toBe(1);

    // Both fake tabs share one window, so both hear it; the lock is released.
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(locks.queued()).toBe(0);
    expect(locks.isHeld()).toBe(false);

    window.dispatchEvent(pageShow(true));
    await flush();
    expect(locks.isHeld()).toBe(true);
    expect(
      first.onChanged.mock.calls.length + second.onChanged.mock.calls.length,
    ).toBeGreaterThan(0);

    // A page loaded fresh (not restored) starts its own poll instead.
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(pageShow(false));
    await flush();
    expect(locks.isHeld()).toBe(false);
  });

  it("syncs every unstreamed account at once on load when versions are unavailable (no Redis)", async () => {
    server.unavailable = true;
    const { onChanged } = poll();
    await flush();

    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
  });

  it("stops asking once stopped", async () => {
    const { stop } = poll();
    await flush();
    stop();

    await minute();

    expect(server.requested).toHaveLength(1);
  });
});

describe("getPolledAccountIds", () => {
  it("names the same accounts in the same order whichever one is open", () => {
    expect(getPolledAccountIds("b", ["a", "b", "c"])).toEqual(
      getPolledAccountIds("c", ["a", "b", "c"]),
    );
  });

  it("includes an open account missing from the list", () => {
    expect(getPolledAccountIds("x", ["a"])).toEqual(["a", "x"]);
  });
});

async function minute() {
  await vi.advanceTimersByTimeAsync(60_000);
  await flush();
}

function pageShow(persisted: boolean) {
  const event = new Event("pageshow") as PageTransitionEvent;
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// Answers like GET /api/mail-version: the versions, or 304 for a matching ETag.
class FakeVersionServer {
  requested: string[][] = [];
  answers: string[] = [];
  unavailable = false;
  readonly versions: Record<string, string | null>;

  constructor(versions: Record<string, string | null>) {
    this.versions = versions;
  }

  async answer(ids: string[], etag: string | null) {
    this.requested.push(ids);
    if (this.unavailable) {
      this.answers.push("503");
      return { status: "unavailable" as const };
    }
    const current = `"${ids.map((id) => this.versions[id]).join(",")}"`;
    if (etag === current) {
      this.answers.push("304");
      return { status: "unchanged" as const };
    }
    this.answers.push("200");
    return {
      status: "changed" as const,
      etag: current,
      versions: Object.fromEntries(ids.map((id) => [id, this.versions[id]])),
    };
  }
}

// One poll lock with a FIFO queue, plus stream locks other tabs hold.
class FakePollLocks {
  readonly streaming: Set<string>;
  private holder: symbol | null = null;
  private readonly queue: (() => void)[] = [];

  constructor(streaming: string[]) {
    this.streaming = new Set(streaming);
  }

  isHeld() {
    return this.holder !== null;
  }

  queued() {
    return this.queue.length;
  }

  query() {
    return Promise.resolve({
      held: [...this.streaming].map((name) => ({ name })),
      pending: [],
    });
  }

  request(
    _name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void> | undefined,
  ) {
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        this.holder = Symbol("poll");
        Promise.resolve(callback()).finally(() => {
          this.holder = null;
          this.queue.shift()?.();
          resolve();
        });
      };
      if (!this.holder) {
        grant();
        return;
      }
      this.queue.push(grant);
      options.signal?.addEventListener("abort", () => {
        const index = this.queue.indexOf(grant);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}
