import { describe, expect, it, vi } from "vitest";
import { describeMailEngineCapabilities } from "@inboxzero/mail-core/capabilities";
import {
  MAIL_IPC_PROTOCOL_VERSION,
  mailIpcRequestSchema,
} from "@inboxzero/mail-core/protocol/mail-ipc";
import { DESKTOP_MAIL_ENGINE_CAPABILITIES } from "./capabilities";
import { dispatchMailIpc, parseMailIpcRequest } from "./ipc";

describe("dispatchMailIpc", () => {
  it("rejects an older IPC protocol version without touching the engine", async () => {
    const result = await dispatchMailIpc({} as never, {
      protocolVersion: 0,
      requestId: "req-1",
      method: "getDiagnostics",
      payload: { accountId: "acc-1" },
    });
    expect(result).toMatchObject({ status: "invalid" });
  });

  it("rejects a missing IPC protocol version", async () => {
    const result = await dispatchMailIpc({} as never, {
      requestId: "req-1",
      method: "getDiagnostics",
      payload: { accountId: "acc-1" },
    });
    expect(result).toMatchObject({ status: "invalid" });
  });

  it("hands a confirmed draft deletion to the desktop engine", async () => {
    const forgetDeletedDrafts = vi.fn(async () => {});
    const result = await dispatchMailIpc({ forgetDeletedDrafts } as never, {
      protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      method: "forgetDeletedDrafts",
      payload: { accountId: "acc-1", messageIds: ["draft-1"] },
    });
    expect(result).toEqual({ status: "ok", result: null });
    expect(forgetDeletedDrafts).toHaveBeenCalledWith({
      accountId: "acc-1",
      messageIds: ["draft-1"],
    });
  });

  it("relays Important stars to the desktop engine", async () => {
    const stars = [
      { accountId: "acc-1", email: "dana@example.com", addedAtMs: 1 },
    ];
    const queryImportantPeople = vi.fn(async () => stars);
    const setImportantPerson = vi.fn(async () => {});
    const engine = { queryImportantPeople, setImportantPerson } as never;

    await expect(
      dispatchMailIpc(engine, {
        protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "queryImportantPeople",
        payload: { accountIds: ["acc-1"] },
      }),
    ).resolves.toEqual({ status: "ok", result: stars });
    expect(queryImportantPeople).toHaveBeenCalledWith(["acc-1"]);

    const star = {
      accountIds: ["acc-1", "acc-2"],
      email: "dana@example.com",
      important: false,
    };
    await expect(
      dispatchMailIpc(engine, {
        protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
        requestId: "req-2",
        method: "setImportantPerson",
        payload: star,
      }),
    ).resolves.toEqual({ status: "ok", result: null });
    expect(setImportantPerson).toHaveBeenCalledWith(star);
  });

  it("relays recipient suggestions to the desktop engine", async () => {
    const suggestions = [{ emailAddress: "dana@example.com", name: "Dana" }];
    const queryContactSuggestions = vi.fn(async () => suggestions);
    const query = {
      accountId: "acc-1",
      query: "da",
      ownAddresses: ["me@example.com"],
      excludeEmails: [],
    };
    await expect(
      dispatchMailIpc({ queryContactSuggestions } as never, {
        protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "queryContactSuggestions",
        payload: query,
      }),
    ).resolves.toEqual({ status: "ok", result: suggestions });
    expect(queryContactSuggestions).toHaveBeenCalledWith(query);
  });

  it("rejects an Important star write beyond the account limit", async () => {
    const setImportantPerson = vi.fn(async () => {});
    const result = await dispatchMailIpc({ setImportantPerson } as never, {
      protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
      requestId: "req-1",
      method: "setImportantPerson",
      payload: {
        accountIds: Array.from({ length: 51 }, (_, index) => `acc-${index}`),
        email: "dana@example.com",
        important: true,
      },
    });
    expect(result).toMatchObject({ status: "invalid" });
    expect(setImportantPerson).not.toHaveBeenCalled();
  });

  it("advertises exactly the optional methods its IPC schema routes", () => {
    const routed = Object.fromEntries(
      mailIpcRequestSchema.options.map((option) => [
        option.shape.method.value,
        () => undefined,
      ]),
    );
    const methods = (capabilities: readonly string[]) =>
      capabilities.filter((feature) => feature.startsWith("method:")).sort();
    expect(methods(DESKTOP_MAIL_ENGINE_CAPABILITIES)).toEqual(
      methods(describeMailEngineCapabilities(routed)),
    );
  });

  it("accepts every query order it advertises", () => {
    const orders = DESKTOP_MAIL_ENGINE_CAPABILITIES.filter((feature) =>
      feature.startsWith("order:"),
    ).map((feature) => feature.slice("order:".length));
    expect(orders.length).toBeGreaterThan(0);
    for (const order of orders) {
      const parsed = parseMailIpcRequest({
        protocolVersion: MAIL_IPC_PROTOCOL_VERSION,
        requestId: "req-1",
        method: "observeMailbox",
        payload: {
          accountIds: ["acc-1"],
          predicate: { kind: "role", role: "inbox" },
          order,
          pageSize: 25,
          after: null,
        },
      });
      expect(parsed.success).toBe(true);
    }
  });
});
