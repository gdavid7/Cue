import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/utils/redis/account-validation";
import { getSharedSubscriber } from "@/utils/redis/shared-subscriber";
import { GET } from "./route";

const mockEnv = vi.hoisted(() => ({
  REDIS_URL: "redis://localhost:6379" as string | undefined,
}));

vi.mock("@/env", () => ({ env: mockEnv }));
vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await import("@/__tests__/helpers");
  return createWithAuthTestMiddleware();
});
vi.mock("@/utils/redis/account-validation", () => ({
  getEmailAccount: vi.fn(),
}));
vi.mock("@/utils/redis/local-mail-hints", () => ({
  TRACKER_HINT_MESSAGE: "tracker-hint",
  localMailHintChannel: (id: string) => `local-mail:${id}`,
}));
vi.mock("@/utils/redis/shared-subscriber", () => ({
  getSharedSubscriber: vi.fn(),
}));

type Listener = { onMessage: (message: string) => void; onLost: () => void };
let listen: ReturnType<typeof makeListen>;

describe("Mail realtime stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mockEnv.REDIS_URL = "redis://localhost:6379";
    listen = makeListen();
    vi.mocked(getSharedSubscriber).mockReturnValue({ listen } as never);
    vi.mocked(getEmailAccount).mockResolvedValue("user@example.com");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects missing or unowned accounts before subscribing", async () => {
    expect(
      (await GET(new NextRequest("http://localhost/api/mail-stream"))).status,
    ).toBe(400);
    vi.mocked(getEmailAccount).mockResolvedValue(null);
    expect((await GET(request())).status).toBe(403);
    expect(listen).not.toHaveBeenCalled();
  });

  // Without Redis there are no hints to relay. Clients poll while the stream
  // is down, so an empty answer keeps them working without a server error.
  it("answers with no stream when Redis is not configured", async () => {
    mockEnv.REDIS_URL = undefined;
    const response = await GET(request());
    expect(response.status).toBe(204);
    expect(listen).not.toHaveBeenCalled();
  });

  it("listens on the account's channel before ready and relays its hints", async () => {
    let resolveSubscription!: () => void;
    listen.ready = new Promise<void>((resolve) => {
      resolveSubscription = resolve;
    });
    const response = await GET(request());
    const reader = response.body!.getReader();
    expect(listen).toHaveBeenCalledWith(
      "local-mail:account-a",
      expect.anything(),
    );
    resolveSubscription();
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(reader)).toContain("event: ready");
    listen.listener().onMessage("secret");
    expect(await read(reader)).toBe("event: mailbox-change\ndata: {}\n\n");
    // Today reloads on tracker changes without the mailbox syncing again.
    listen.listener().onMessage("tracker-hint");
    expect(await read(reader)).toBe("event: trackers-change\ndata: {}\n\n");
    await reader.cancel();
    expect(listen.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  // The heartbeat only keeps proxies from closing an idle stream; with
  // thousands of open tabs a Redis write per beat would dominate the load.
  it("sends heartbeats without touching Redis", async () => {
    const response = await GET(request());
    const reader = response.body!.getReader();
    await vi.advanceTimersByTimeAsync(0);
    expect(await read(reader)).toContain("event: ready");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await read(reader)).toContain("event: heartbeat");
    expect(listen).toHaveBeenCalledOnce();
    await reader.cancel();
  });

  it.each(["abort", "lost", "cancel"])("cleans up after %s", async (cause) => {
    const abort = new AbortController();
    const response = await GET(request(abort.signal));
    await vi.advanceTimersByTimeAsync(0);
    if (cause === "abort") abort.abort();
    if (cause === "lost") listen.listener().onLost();
    if (cause === "cancel") await response.body!.cancel();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(listen.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends at its absolute lifetime even when hints keep arriving", async () => {
    await GET(request());
    await vi.advanceTimersByTimeAsync(269_000);
    listen.listener().onMessage("{}");
    expect(listen.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(listen.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes when the subscription fails", async () => {
    listen.ready = Promise.reject(new Error("Unavailable"));
    const response = await GET(request());
    expect(await response.body!.getReader().read()).toEqual({
      done: true,
      value: undefined,
    });
    expect(listen.close).toHaveBeenCalledOnce();
  });
});

function request(signal?: AbortSignal) {
  return new NextRequest(
    "http://localhost/api/mail-stream?emailAccountId=account-a",
    { signal },
  );
}
async function read(reader: ReadableStreamDefaultReader<Uint8Array>) {
  return new TextDecoder().decode((await reader.read()).value);
}

function makeListen() {
  let current: Listener | null = null;
  const fn = Object.assign(
    vi.fn((_channel: string, listener: Listener) => {
      current = listener;
      return { ready: fn.ready, close: fn.close };
    }),
    {
      ready: Promise.resolve() as Promise<void>,
      close: vi.fn(),
      listener: () => current!,
    },
  );
  return fn;
}
