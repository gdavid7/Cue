// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftReplies } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies";

const mocks = vi.hoisted(() => ({
  enableDraftReplies: vi.fn(),
  mutateRules: vi.fn(),
  mutateGlobal: vi.fn(),
}));

vi.mock("@/utils/actions/rule", () => ({
  enableDraftRepliesAction: mocks.enableDraftReplies,
}));
vi.mock("@/hooks/useRules", () => ({
  useRules: () => ({
    data: [],
    mutate: mocks.mutateRules,
    isLoading: false,
    error: undefined,
  }),
}));
vi.mock("swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("swr")>()),
  useSWRConfig: () => ({ mutate: mocks.mutateGlobal }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "ea_1" }),
}));
vi.mock("@/env", () => ({ env: {} }));

describe("useDraftReplies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A server error comes back as data, not a throw: it must still fail, or
  // callers report success and hide their prompt for good.
  it("fails with the server's reason", async () => {
    mocks.enableDraftReplies.mockResolvedValue({
      serverError:
        'You already have a rule named "To Reply". Rename it and try again.',
    });
    const { result } = renderHook(() => useDraftReplies());

    await expect(result.current.toggleDraftReplies(true)).rejects.toThrow(
      'You already have a rule named "To Reply". Rename it and try again.',
    );
    expect(mocks.mutateRules).toHaveBeenCalled();
  });

  // To Reply is reply tracking too, so Mail's notice must not go stale.
  it("refreshes the mail settings after a change", async () => {
    mocks.enableDraftReplies.mockResolvedValue({ data: undefined });
    const { result } = renderHook(() => useDraftReplies());

    await result.current.toggleDraftReplies(true);

    expect(mocks.mutateGlobal).toHaveBeenCalledWith("/api/mail/settings");
  });
});
