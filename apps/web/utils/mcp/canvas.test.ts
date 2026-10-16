import { describe, expect, it, vi } from "vitest";
import {
  canvasCheckMessage,
  normalizeSiteAddress,
  verifyCanvasToken,
} from "@/utils/mcp/canvas";

vi.mock("@/env", () => ({ env: { MCP_ALLOW_PRIVATE_IPS: false } }));

const TOKEN = "test-canvas-token";

describe("normalizeSiteAddress", () => {
  it.each([
    ["canvas.eee.uci.edu", "https://canvas.eee.uci.edu"],
    ["https://canvas.eee.uci.edu/", "https://canvas.eee.uci.edu"],
    ["  https://canvas.eee.uci.edu/api/v1  ", "https://canvas.eee.uci.edu"],
    ["https://canvas.eee.uci.edu/api/v1/", "https://canvas.eee.uci.edu"],
    [
      "https://canvas.eee.uci.edu/courses/12345/assignments?x=1#top",
      "https://canvas.eee.uci.edu",
    ],
    ["http://canvas.eee.uci.edu", "https://canvas.eee.uci.edu"],
    ["HTTPS://Canvas.EEE.uci.edu", "https://canvas.eee.uci.edu"],
    ["canvas.school.edu:8443", "https://canvas.school.edu:8443"],
    ["canvas.school.edu:8443/courses/1", "https://canvas.school.edu:8443"],
  ])("turns %s into its https origin", (input, expected) => {
    expect(normalizeSiteAddress(input)).toBe(expected);
  });

  it.each([
    "",
    "not a url",
    "ftp://canvas.eee.uci.edu",
    "javascript:alert(1)",
  ])("refuses %j", (input) => {
    expect(normalizeSiteAddress(input)).toBeNull();
  });
});

describe("verifyCanvasToken", () => {
  it("asks Canvas who the token belongs to, at the site's API", async () => {
    const fetch = mockFetch(() => json(200, { id: 42, name: "Ada Lovelace" }));

    const result = await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu/courses/1",
      token: TOKEN,
      fetch,
    });

    expect(result).toEqual({
      ok: true,
      origin: "https://canvas.eee.uci.edu",
      user: { id: "42", name: "Ada Lovelace" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://canvas.eee.uci.edu/api/v1/users/self");
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("names the account by its short name when Canvas has no full name", async () => {
    const result = await verifyCanvasToken({
      address: "canvas.eee.uci.edu",
      token: TOKEN,
      fetch: mockFetch(() => json(200, { id: 7, short_name: "Ada" })),
    });

    expect(result).toMatchObject({ ok: true, user: { id: "7", name: "Ada" } });
  });

  it.each([
    [401, "rejected"],
    [403, "rejected"],
    [404, "not_canvas"],
    [500, "unreachable"],
    [502, "unreachable"],
    [429, "unreachable"],
  ])("reads a %i as %s", async (status, reason) => {
    const result = await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu",
      token: TOKEN,
      fetch: mockFetch(() =>
        json(status, { errors: [{ message: "Invalid access token." }] }),
      ),
    });

    expect(result).toEqual({ ok: false, reason });
  });

  it("says a site answering with a web page isn't Canvas", async () => {
    const result = await verifyCanvasToken({
      address: "https://www.example.edu",
      token: TOKEN,
      fetch: mockFetch(
        () =>
          new Response("<html>Welcome</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    });

    expect(result).toEqual({ ok: false, reason: "not_canvas" });
  });

  it("says JSON without a user isn't Canvas", async () => {
    const result = await verifyCanvasToken({
      address: "https://api.example.edu",
      token: TOKEN,
      fetch: mockFetch(() => json(200, { status: "ok" })),
    });

    expect(result).toEqual({ ok: false, reason: "not_canvas" });
  });

  it("follows a redirect within the same site", async () => {
    const fetch = mockFetch((url) =>
      url.endsWith("/users/self")
        ? redirect("/api/v1/users/self/")
        : json(200, { id: 1, name: "Ada" }),
    );

    const result = await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu",
      token: TOKEN,
      fetch,
    });

    expect(result).toMatchObject({ ok: true });
    expect(fetch.mock.calls[1][0]).toBe(
      "https://canvas.eee.uci.edu/api/v1/users/self/",
    );
  });

  it("shares one deadline across redirects and drops each redirect's body", async () => {
    const cancel = vi.fn();
    const fetch = mockFetch((url) =>
      url.endsWith("/users/self")
        ? new Response(new ReadableStream({ cancel }), {
            status: 302,
            headers: { location: "/api/v1/users/self/" },
          })
        : json(200, { id: 1, name: "Ada" }),
    );

    await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu",
      token: TOKEN,
      fetch,
    });

    expect(fetch.mock.calls[0][1].signal).toBe(fetch.mock.calls[1][1].signal);
    expect(cancel).toHaveBeenCalled();
  });

  it("doesn't read an answer far bigger than a Canvas user", async () => {
    const declared = await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu",
      token: TOKEN,
      fetch: mockFetch(
        () =>
          new Response("{}", {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(10 * 1024 * 1024),
            },
          }),
      ),
    });
    const streamed = await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu",
      token: TOKEN,
      fetch: mockFetch(
        () =>
          new Response(
            JSON.stringify({ id: 1, name: "Ada", bio: "x".repeat(200_000) }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    });

    expect(declared).toEqual({ ok: false, reason: "not_canvas" });
    expect(streamed).toEqual({ ok: false, reason: "not_canvas" });
  });

  it("doesn't send the token to another site it redirects to", async () => {
    const fetch = mockFetch(() =>
      redirect("https://sso.example.edu/login?service=canvas"),
    );

    const result = await verifyCanvasToken({
      address: "https://canvas.example.edu",
      token: TOKEN,
      fetch,
    });

    expect(result).toEqual({ ok: false, reason: "redirected" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says Canvas couldn't be reached when the request fails or times out", async () => {
    const timedOut = await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu",
      token: TOKEN,
      fetch: vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    });
    const refused = await verifyCanvasToken({
      address: "https://canvas.eee.uci.edu",
      token: TOKEN,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });

    expect(timedOut).toEqual({ ok: false, reason: "unreachable" });
    expect(refused).toEqual({ ok: false, reason: "unreachable" });
  });

  it("never calls a private, loopback or link-local address", async () => {
    const fetch = mockFetch(() => json(200, { id: 1, name: "Ada" }));

    for (const address of [
      "https://10.0.0.5",
      "https://127.0.0.1",
      "https://localhost",
      "https://169.254.169.254",
      "https://[::1]",
    ]) {
      expect(await verifyCanvasToken({ address, token: TOKEN, fetch })).toEqual(
        { ok: false, reason: "not_canvas" },
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an address that isn't a web address", async () => {
    const fetch = mockFetch(() => json(200, { id: 1 }));

    const result = await verifyCanvasToken({
      address: "not a url",
      token: TOKEN,
      fetch,
    });

    expect(result).toEqual({ ok: false, reason: "not_canvas" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("canvasCheckMessage", () => {
  it("gives plain, specific messages", () => {
    expect(canvasCheckMessage("rejected")).toBe(
      "Canvas rejected this token. Check it or create a new one.",
    );
    expect(canvasCheckMessage("not_canvas")).toBe(
      "That address doesn't look like a Canvas site.",
    );
    expect(canvasCheckMessage("unreachable")).toBe(
      "Couldn't reach Canvas. Try again.",
    );
    expect(canvasCheckMessage("redirected")).toBe(
      "That address sends you to another site. Enter the address Canvas opens at.",
    );
  });
});

type MockFetch = ReturnType<
  typeof vi.fn<
    (
      url: string,
      init: RequestInit & { headers: Record<string, string> },
    ) => Promise<Response>
  >
>;

function mockFetch(answer: (url: string) => Response): MockFetch {
  return vi.fn(async (url: string) => answer(url));
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } });
}
