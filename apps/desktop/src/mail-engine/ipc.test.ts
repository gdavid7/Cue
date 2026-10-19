import { describe, expect, it, vi } from "vitest";
import { MAIL_IPC_PROTOCOL_VERSION } from "@inboxzero/mail-core/protocol/mail-ipc";
import { dispatchMailIpc } from "./ipc";

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
});
