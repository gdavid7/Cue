import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordActiveDay } from "@/utils/analytics/activation";

const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importActual) => ({
  ...(await importActual<typeof import("next/server")>()),
  after: (callback: () => unknown) => afterCallbacks.push(callback),
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailProviderTestMiddleware({});
});
vi.mock("@/utils/home/get-home", () => ({
  getHomeData: vi.fn(async () => ({})),
}));
vi.mock("@/utils/analytics/activation", () => ({
  recordActiveDay: vi.fn(),
}));
vi.mock("@/utils/user/own-addresses", () => ({
  getUserOwnAddresses: vi.fn(async () => []),
}));

import { getHomeData } from "@/utils/home/get-home";
import { getUserOwnAddresses } from "@/utils/user/own-addresses";
import { GET } from "./route";

describe("GET /api/user/home", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
  });

  it("counts opening Today as an active day once the response is sent", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/api/user/home"),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(recordActiveDay).not.toHaveBeenCalled();
    for (const callback of afterCallbacks) await callback();
    expect(recordActiveDay).toHaveBeenCalledWith("email-account-1");
  });

  it("checks declined meetings against every address the user has connected", async () => {
    vi.mocked(getUserOwnAddresses).mockResolvedValue(["other@example.com"]);

    await getToday();

    expect(await vi.mocked(getHomeData).mock.calls[0][0].ownAddresses).toEqual(
      expect.arrayContaining(["other@example.com"]),
    );
  });

  it("starts Today's reads without waiting for the user's addresses", async () => {
    let resolveAddresses: (addresses: string[]) => void = () => undefined;
    vi.mocked(getUserOwnAddresses).mockReturnValue(
      new Promise((resolve) => {
        resolveAddresses = resolve;
      }),
    );

    const response = getToday();
    await vi.waitFor(() => expect(getHomeData).toHaveBeenCalled());
    resolveAddresses(["other@example.com"]);

    expect((await response).status).toBe(200);
  });

  it("still loads Today when the user's addresses can't be read", async () => {
    vi.mocked(getUserOwnAddresses).mockRejectedValue(new Error("Redis down"));

    const response = await getToday();

    expect(response.status).toBe(200);
    expect(
      await vi.mocked(getHomeData).mock.calls[0][0].ownAddresses,
    ).toHaveLength(1);
  });
});

function getToday() {
  return GET(new NextRequest("http://localhost:3000/api/user/home"), {
    params: Promise.resolve({}),
  });
}
