import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";

const { envMock, getContactPhotosMock } = vi.hoisted(() => ({
  envMock: { NEXT_PUBLIC_CONTACTS_ENABLED: true },
  getContactPhotosMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({ env: envMock }));
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));
vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (
      _scope: string,
      handler: (
        request: NextRequest & Record<string, unknown>,
      ) => Promise<Response>,
    ) =>
    (request: NextRequest) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "account-1" },
          emailProvider: { getContactPhotos: getContactPhotosMock },
          logger: createTestLogger(),
        }),
      ),
}));

import { GET } from "./route";

describe("GET /api/user/contacts/photos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingRedis.reset();
    envMock.NEXT_PUBLIC_CONTACTS_ENABLED = true;
  });

  // RD-3: photos name the user's contacts, so the browser keeps them.
  it("returns the swept photos without keeping them on the server", async () => {
    getContactPhotosMock.mockResolvedValue({
      "a@example.com": "https://photo/a",
    });

    expect(await getPhotos()).toEqual({
      photos: { "a@example.com": "https://photo/a" },
      swept: true,
    });
    expect(await getPhotos()).toMatchObject({ swept: true });
    expect(getContactPhotosMock).toHaveBeenCalledTimes(2);
    expect(recordingRedis.everythingWritten()).not.toContain("a@example.com");
  });

  it("pauses sweeping for a while after a failed sweep", async () => {
    getContactPhotosMock.mockRejectedValue(new Error("rate limited"));

    expect(await getPhotos()).toEqual({ photos: {}, swept: false });
    expect(await getPhotos()).toEqual({ photos: {}, swept: false });

    expect(getContactPhotosMock).toHaveBeenCalledTimes(1);
    expect(recordingRedis.writes).toEqual([
      { key: "contact-photos-paused:account-1", value: "1" },
    ]);
  });

  it("does not query the provider when contacts are disabled", async () => {
    envMock.NEXT_PUBLIC_CONTACTS_ENABLED = false;

    const response = await GET(
      new NextRequest("http://localhost:3000/api/user/contacts/photos"),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(404);
    expect(getContactPhotosMock).not.toHaveBeenCalled();
  });
});

async function getPhotos() {
  const response = await GET(
    new NextRequest("http://localhost:3000/api/user/contacts/photos"),
    { params: Promise.resolve({}) },
  );
  return response.json();
}
