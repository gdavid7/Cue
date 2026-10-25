// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailWaitingSummary } from "@inboxzero/mail-core/engine";
import { ChangesWaiting } from "@/app/(app)/[emailAccountId]/mail/ChangesWaiting";

const engine = vi.hoisted(() => ({
  capabilities: ["method:getWaitingSummary"] as string[],
  getWaitingSummary: vi.fn(),
  getDiagnostics: vi.fn(),
  requestSync: vi.fn(),
}));
const toast = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => engine,
}));
vi.mock("@/components/Toast", () => toast);
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
  engine.capabilities = ["method:getWaitingSummary"];
  engine.getWaitingSummary.mockReset();
  engine.getDiagnostics.mockReset();
  engine.requestSync.mockReset().mockResolvedValue({ status: "scheduled" });
  toast.toastError.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChangesWaiting", () => {
  it("says how many changes are waiting and retries them on request", async () => {
    engine.getWaitingSummary.mockResolvedValue([
      summary([group({ status: "retry_wait", count: 2 })]),
    ]);
    renderIndicator();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "2 changes waiting to reach Gmail",
      }),
    );
    expect(engine.getWaitingSummary).toHaveBeenCalledWith(["account-1"]);
    expect(screen.getByText("me@example.com")).toBeTruthy();
    expect(screen.getByText("Retrying · 2 changes · Archive ×2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    expect(engine.requestSync).toHaveBeenCalledWith(["account-1"]);
  });

  it("says so when Try now can't reach the engine", async () => {
    engine.getWaitingSummary.mockResolvedValue([summary([group({})])]);
    engine.requestSync.mockRejectedValue(new Error("closed"));
    renderIndicator();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "1 change waiting to reach Gmail",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    await vi.waitFor(() => expect(toast.toastError).toHaveBeenCalledOnce());
  });

  it("offers reconnecting a signed-out account", async () => {
    engine.getWaitingSummary.mockResolvedValue([
      { ...summary([]), connection: "blocked_auth" },
    ]);
    renderIndicator();

    fireEvent.click(
      await screen.findByRole("button", { name: "Gmail needs reconnecting" }),
    );
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try now" })).toBeNull();
  });

  // The popover is built from kinds and counts only. An engine that ever
  // sent more, such as the label a change applies, must not get it shown.
  it("never shows a label or category name", async () => {
    engine.getWaitingSummary.mockResolvedValue([
      summary([
        {
          ...group({
            changeKind: "set_membership",
            membership: "label",
            on: true,
          }),
          id: "Private label name",
          name: "Private category name",
        } as MailWaitingSummary["groups"][number],
      ]),
    ]);
    renderIndicator();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "1 change waiting to reach Gmail",
      }),
    );
    expect(screen.getByText("Waiting · 1 change · Label")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Private/);
  });

  it("never polls the heavy diagnostics on an engine without the summary", async () => {
    engine.capabilities = [];
    const { container } = renderIndicator();

    await act(async () => {});
    expect(engine.getWaitingSummary).not.toHaveBeenCalled();
    expect(engine.getDiagnostics).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("keeps the last known changes, marked stale, when reads start failing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    engine.getWaitingSummary.mockResolvedValueOnce([summary([group({})])]);
    engine.getWaitingSummary.mockRejectedValue(new Error("unavailable"));
    renderIndicator();
    const trigger = await screen.findByRole("button", {
      name: "1 change waiting to reach Gmail",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(engine.getWaitingSummary).toHaveBeenCalledTimes(2);
    fireEvent.click(trigger);
    expect(
      screen.getByText(
        "Couldn't check just now. Showing the last known status.",
      ),
    ).toBeTruthy();
  });

  it("claims nothing when every read fails, and doesn't speed up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    engine.getWaitingSummary.mockRejectedValue(new Error("unavailable"));
    const { container } = renderIndicator();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(engine.getWaitingSummary).toHaveBeenCalledOnce();
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

function summary(groups: MailWaitingSummary["groups"]): MailWaitingSummary {
  return {
    accountId: "account-1",
    connection: "ready",
    oldestWaitingAtMs: groups[0]?.oldestWaitingAtMs ?? null,
    groups,
  };
}

function group(
  overrides: Partial<MailWaitingSummary["groups"][number]>,
): MailWaitingSummary["groups"][number] {
  return {
    status: "queued",
    kind: "conversations",
    changeKind: "archive",
    on: null,
    membership: null,
    heldOffline: false,
    count: 1,
    oldestWaitingAtMs: Date.now() - 60_000,
    ...overrides,
  };
}
