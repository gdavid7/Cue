// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailEngineConnectionBanner } from "@/utils/mail-engine/MailEngineConnectionBanner";

const mailbox = vi.hoisted(() => ({
  connection: "ready" as "ready" | "offline" | "blocked_auth",
  listeners: new Set<() => void>(),
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({
    observeMailbox: () => ({
      getSnapshot: () => ({ data: { connection: mailbox.connection } }),
      subscribe: (listener: () => void) => {
        mailbox.listeners.add(listener);
        return () => mailbox.listeners.delete(listener);
      },
      close: () => {},
    }),
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1", provider: "google" }),
}));

let online = true;

beforeEach(() => {
  online = true;
  mailbox.connection = "ready";
  mailbox.listeners.clear();
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MailEngineConnectionBanner", () => {
  it("says nothing while connected", () => {
    render(<MailEngineConnectionBanner />);

    expect(screen.queryByRole("status")).toBeNull();
  });

  // Sync defers while the browser is offline, so the engine never gets a
  // failed sync to report; without this the stale inbox reads as current.
  it("tells the user while the browser is offline, until it's back", () => {
    render(<MailEngineConnectionBanner />);

    setOnline(false);
    expect(screen.getByRole("status").textContent).toContain(
      "Can't reach your mailbox right now.",
    );

    setOnline(true);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells the user while the engine can't reach the server", () => {
    render(<MailEngineConnectionBanner />);

    setEngineConnection("offline");
    expect(screen.getByRole("status").textContent).toContain(
      "Can't reach your mailbox right now.",
    );

    setEngineConnection("ready");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

function setOnline(value: boolean) {
  online = value;
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

function setEngineConnection(connection: "ready" | "offline") {
  mailbox.connection = connection;
  act(() => {
    for (const listener of mailbox.listeners) listener();
  });
}
