import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetMutedThreadIds,
  loadMutedThreadIds,
} from "@/utils/web-notifications/muted-thread-ids";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function respond(threadIds: string[]) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ threadIds }),
  });
}

afterEach(() => {
  fetchMock.mockReset();
  forgetMutedThreadIds("acc");
});

describe("loadMutedThreadIds", () => {
  it("reads once a minute, then again", async () => {
    respond(["a"]);
    expect(await loadMutedThreadIds("acc", 0)).toEqual(new Set(["a"]));
    expect(await loadMutedThreadIds("acc", 59_000)).toEqual(new Set(["a"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    respond(["a", "b"]);
    expect(await loadMutedThreadIds("acc", 61_000)).toEqual(
      new Set(["a", "b"]),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads again straight after a mute clears it", async () => {
    respond([]);
    await loadMutedThreadIds("acc", 0);
    forgetMutedThreadIds("acc");
    respond(["new"]);

    expect(await loadMutedThreadIds("acc", 1000)).toEqual(new Set(["new"]));
  });

  it("is null when it can't be read, and doesn't keep that", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    expect(await loadMutedThreadIds("acc", 0)).toBeNull();
    respond(["a"]);
    expect(await loadMutedThreadIds("acc", 1)).toEqual(new Set(["a"]));
  });
});
