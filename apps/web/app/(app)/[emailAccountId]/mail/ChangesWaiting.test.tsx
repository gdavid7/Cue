// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailDiagnostics } from "@inboxzero/mail-core/engine";
import { ChangesWaiting } from "@/app/(app)/[emailAccountId]/mail/ChangesWaiting";

const engine = vi.hoisted(() => ({
  getDiagnostics: vi.fn(),
  requestSync: vi.fn(),
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => engine,
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1", provider: "google" }),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: {
      emailAccounts: [
        {
          id: "account-1",
          email: "me@example.com",
          account: { provider: "google", disconnectedAt: null },
        },
      ],
    },
  }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailSidebar", () => ({
  RailTooltip: ({ children }: { children: ReactNode }) => children,
}));

beforeEach(() => {
  engine.getDiagnostics.mockReset();
  engine.requestSync.mockReset().mockResolvedValue({ status: "scheduled" });
});

afterEach(() => {
  cleanup();
});

describe("ChangesWaiting", () => {
  it("says how many changes are waiting and retries them on request", async () => {
    engine.getDiagnostics.mockResolvedValue(
      diagnostics({
        oldestPendingAtMs: Date.now() - 60_000,
        commands: [
          command("queued", "archive"),
          command("retry_wait", "archive"),
        ],
      }),
    );
    renderIndicator();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "2 changes waiting to reach Gmail",
      }),
    );
    expect(screen.getByText("me@example.com")).toBeTruthy();
    expect(screen.getByText("Retrying · 2 changes · Archive ×2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    expect(engine.requestSync).toHaveBeenCalledWith(["account-1"]);
  });

  it("offers reconnecting a signed-out account", async () => {
    engine.getDiagnostics.mockResolvedValue(
      diagnostics({ connection: "blocked_auth" }),
    );
    renderIndicator();

    fireEvent.click(
      await screen.findByRole("button", { name: "Gmail needs reconnecting" }),
    );
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try now" })).toBeNull();
  });

  it("shows nothing when the engine can't report diagnostics", async () => {
    engine.getDiagnostics.mockRejectedValue(new Error("unsupported"));
    const { container } = renderIndicator();

    await vi.waitFor(() =>
      expect(engine.getDiagnostics).toHaveBeenCalledWith("account-1"),
    );
    await Promise.resolve();
    expect(container.textContent).toBe("");
  });
});

function renderIndicator() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ChangesWaiting />
    </SWRConfig>,
  );
}

function diagnostics(overrides: Partial<MailDiagnostics>): MailDiagnostics {
  return {
    accountId: "account-1",
    revision: { databaseEpoch: "epoch", sequence: 1 },
    connection: "ready",
    coverage: [],
    pendingOperations: overrides.commands?.length ?? 0,
    uncertainOperations: 0,
    pendingJobs: 0,
    oldestPendingAtMs: null,
    commands: [],
    ...overrides,
  };
}

function command(
  status: MailDiagnostics["commands"][number]["status"],
  changeKind: string,
): MailDiagnostics["commands"][number] {
  return {
    operationId: `${status}-${Math.random()}`,
    status,
    kind: "conversations",
    changeKind,
    change: { kind: changeKind },
    messageIds: [],
    conversationIds: [],
  };
}
