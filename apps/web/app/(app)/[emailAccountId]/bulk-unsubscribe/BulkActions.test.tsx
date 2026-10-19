/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkActions } from "@/app/(app)/[emailAccountId]/bulk-unsubscribe/BulkActions";

(globalThis as { React?: typeof React }).React = React;

const mocks = vi.hoisted(() => ({ onBulkUnsubscribe: vi.fn() }));

vi.mock("@/app/(app)/[emailAccountId]/bulk-unsubscribe/hooks", () => ({
  useBulkUnsubscribe: () => ({ onBulkUnsubscribe: mocks.onBulkUnsubscribe }),
  useBulkApprove: () => ({ onBulkApprove: vi.fn() }),
  useBulkAutoArchive: () => ({ onBulkAutoArchive: vi.fn() }),
  useBulkArchive: () => ({ onBulkArchive: vi.fn(), isBulkArchiving: false }),
  useBulkDelete: () => ({ onBulkDelete: vi.fn(), isBulkDeleting: false }),
}));
vi.mock("@/hooks/usePremium", () => ({
  usePremium: () => ({ hasUnsubscribeAccess: true, mutate: vi.fn() }),
}));
vi.mock("@/app/(app)/premium/PremiumModal", () => ({
  usePremiumModal: () => ({ PremiumModal: () => null, openModal: vi.fn() }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));
vi.mock("@/utils/analytics/posthog-client", () => ({ posthog: {} }));
vi.mock("@/components/SenderIcon", () => ({ SenderIcon: () => null }));
vi.mock("@/components/PremiumAlert", () => ({
  PremiumTooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock(
  "@/app/(app)/[emailAccountId]/bulk-unsubscribe/UnsubscribeCelebrationDialog",
  () => ({ UnsubscribeCelebrationDialog: () => null }),
);

describe("BulkActions unsubscribe", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("asks once for the whole selection before sending unsubscribes", () => {
    renderActions([
      newsletter("a@example.com", "https://example.com/a"),
      newsletter("b@example.com", "https://example.com/b"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));

    expect(mocks.onBulkUnsubscribe).not.toHaveBeenCalled();
    expect(screen.getByText("Unsubscribe from 2 senders?")).toBeTruthy();
    expect(screen.getByText(/can't be undone from Cue/)).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Unsubscribe" }).at(-1)!,
    );

    expect(mocks.onBulkUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.onBulkUnsubscribe.mock.calls[0][0]).toHaveLength(2);
  });

  it("blocks senders without a link straight away, since that can be reversed", () => {
    renderActions([newsletter("a@example.com", null)]);

    fireEvent.click(screen.getByRole("button", { name: "Block" }));

    expect(mocks.onBulkUnsubscribe).toHaveBeenCalledTimes(1);
  });
});

function renderActions(newsletters: ReturnType<typeof newsletter>[]) {
  render(
    <BulkActions
      selected={new Map(newsletters.map((n) => [n.name, true]))}
      mutate={vi.fn()}
      onClearSelection={vi.fn()}
      deselectItem={vi.fn()}
      newsletters={newsletters as never}
      filter="unhandled"
    />,
  );
}

function newsletter(name: string, unsubscribeLink: string | null) {
  return {
    name,
    fromName: name,
    value: 3,
    inboxEmails: 3,
    readEmails: 0,
    lastEmailAt: 0,
    unsubscribeLink,
    status: null,
  };
}
