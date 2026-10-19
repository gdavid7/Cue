/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollMailVersions } from "./poll-mail-versions";

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

  it("syncs only the accounts whose version moved, and nothing while a 304 says nothing did", async () => {
    const { onChanged } = poll();

    await minute();
    expect(onChanged).not.toHaveBeenCalled();

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

  it("leaves accounts another tab is streaming to that stream", async () => {
    const locks = new FakePollLocks(["cue:mail-stream:a"]);
    const { onChanged } = poll(locks);

    await minute();
    expect(server.requested.at(-1)).toEqual(["b"]);

    // The stream lock lets go (that tab went hidden): the poll covers it again.
    locks.streaming.clear();
    server.versions.a = "9";
    await minute();
    expect(server.requested.at(-1)).toEqual(["a", "b"]);
    await minute();
    expect(onChanged).not.toHaveBeenCalledWith(["b"]);
  });

  it("asks nothing while every account is streamed", async () => {
    const locks = new FakePollLocks(["cue:mail-stream:a", "cue:mail-stream:b"]);
    poll(locks);

    await minute();
    await minute();

    expect(server.requested).toEqual([]);
  });

  it("polls from one tab per browser, and the next takes over when it closes", async () => {
    const locks = new FakePollLocks([]);
    const first = poll(locks);
    poll(locks);

    await minute();
    expect(server.requested).toHaveLength(1);

    first.stop();
    await flush();
    await minute();
    expect(server.requested).toHaveLength(2);
  });

  it("hands its baseline to the next tab, so a change during the handover still syncs", async () => {
    const locks = new FakePollLocks([]);
    const first = poll(locks);
    const second = poll(locks);
    await minute();

    first.stop();
    server.versions.a = "2";
    await flush();
    await minute();

    expect(second.onChanged).toHaveBeenCalledExactlyOnceWith(["a"]);
  });

  it("syncs every unstreamed account directly while versions are unavailable", async () => {
    server.unavailable = true;
    const { onChanged } = poll();

    await minute();

    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
  });

  it("stops asking once stopped", async () => {
    const { stop } = poll();
    stop();

    await minute();

    expect(server.requested).toEqual([]);
  });
});

async function minute() {
  await vi.advanceTimersByTimeAsync(60_000);
  await flush();
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
