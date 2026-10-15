/** @vitest-environment jsdom */

import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SnoozeDateParser } from "@/app/(app)/[emailAccountId]/mail/snooze-date-parse";
import { useSnoozeDateParser } from "./useSnoozeDateParser";

const parser: SnoozeDateParser = () => null;

describe("useSnoozeDateParser", () => {
  it("loads the parser once it is needed", async () => {
    const load = vi.fn(async () => parser);
    const { result, rerender } = renderHook(
      ({ needed }) => useSnoozeDateParser(needed, load),
      { initialProps: { needed: false } },
    );
    expect(load).not.toHaveBeenCalled();

    rerender({ needed: true });

    await waitFor(() => expect(result.current).toBe(parser));
    expect(load).toHaveBeenCalledOnce();
  });

  it("tries again the next time it is needed after the chunk fails to load", async () => {
    const load = vi
      .fn<() => Promise<SnoozeDateParser>>()
      .mockRejectedValueOnce(new Error("ChunkLoadError"))
      .mockResolvedValueOnce(parser);
    const { result, rerender } = renderHook(
      ({ needed }) => useSnoozeDateParser(needed, load),
      { initialProps: { needed: true } },
    );
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(result.current).toBeNull();

    rerender({ needed: false });
    rerender({ needed: true });

    await waitFor(() => expect(result.current).toBe(parser));
    expect(load).toHaveBeenCalledTimes(2);
  });
});
