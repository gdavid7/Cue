import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSharedSubscriber } from "./shared-subscriber";

describe("createSharedSubscriber", () => {
  // Every open tab holds a stream; one Redis connection per instance serves
  // them all, subscribing to an account's channel once however many tabs
  // follow it.
  it("opens one connection and one subscription for many listeners", async () => {
    const { client, createClient } = fakeRedis();
    const shared = createSharedSubscriber(createClient);
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();

    const a = shared.listen("local-mail:a", listener(first));
    const b = shared.listen("local-mail:a", listener(second));
    const c = shared.listen("local-mail:b", listener(other));
    await Promise.all([a.ready, b.ready, c.ready]);
    client.emit("message", "local-mail:a", "{}");

    expect(createClient).toHaveBeenCalledOnce();
    expect(client.subscribe).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledWith("{}");
    expect(second).toHaveBeenCalledWith("{}");
    expect(other).not.toHaveBeenCalled();
  });

  it("unsubscribes only when the channel's last listener leaves", async () => {
    const { client, createClient } = fakeRedis();
    const shared = createSharedSubscriber(createClient);
    const a = shared.listen("local-mail:a", listener(vi.fn()));
    const b = shared.listen("local-mail:a", listener(vi.fn()));
    await Promise.all([a.ready, b.ready]);

    a.close();
    expect(client.unsubscribe).not.toHaveBeenCalled();
    b.close();
    expect(client.unsubscribe).toHaveBeenCalledWith("local-mail:a");

    const again = shared.listen("local-mail:a", listener(vi.fn()));
    await again.ready;
    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });

  // Messages sent while the connection is down are lost, so a stream that
  // was live closes and its tab reconnects and catches up. A stream still
  // waiting for its subscription keeps waiting, so an outage doesn't turn
  // into a reconnect loop.
  it("tells live listeners when the connection drops", async () => {
    const { client, createClient } = fakeRedis();
    const shared = createSharedSubscriber(createClient);
    const lost = vi.fn();
    const live = shared.listen("local-mail:a", {
      onMessage: vi.fn(),
      onLost: lost,
    });
    await live.ready;
    const waitingLost = vi.fn();
    client.subscribe.mockReturnValueOnce(new Promise(() => {}));
    shared.listen("local-mail:b", { onMessage: vi.fn(), onLost: waitingLost });

    client.emit("close");

    expect(lost).toHaveBeenCalledOnce();
    expect(waitingLost).not.toHaveBeenCalled();
  });

  it("lets the next listener retry a subscription that failed", async () => {
    const { client, createClient } = fakeRedis();
    const shared = createSharedSubscriber(createClient);
    client.subscribe.mockRejectedValueOnce(new Error("refused"));

    await expect(
      shared.listen("local-mail:a", listener(vi.fn())).ready,
    ).rejects.toThrow("refused");
    await shared.listen("local-mail:a", listener(vi.fn())).ready;

    expect(client.subscribe).toHaveBeenCalledTimes(2);
  });
});

function listener(onMessage: (message: string) => void) {
  return { onMessage, onLost: vi.fn() };
}

function fakeRedis() {
  const client = Object.assign(new EventEmitter(), {
    subscribe: vi.fn().mockResolvedValue(1),
    unsubscribe: vi.fn().mockResolvedValue(1),
  });
  return { client, createClient: vi.fn(() => client as never) };
}
