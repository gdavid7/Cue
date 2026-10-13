import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isExaSearchEnabled, searchExa } from "@/utils/exa/search";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    EXA_API_KEY: "test-exa-key" as string | undefined,
    EXA_API_URL: "https://api.exa.ai",
  },
}));

vi.mock("@/env", () => ({ env: mockEnv }));

const fetchMock = vi.fn();

describe("searchExa", () => {
  beforeEach(() => {
    mockEnv.EXA_API_KEY = "test-exa-key";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends an authenticated search and normalizes the results", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        requestId: "req-1",
        results: [
          {
            id: "doc-1",
            title: "Acme raises Series B",
            url: "https://news.example.com/acme",
            publishedDate: "2026-09-01T00:00:00.000Z",
            author: null,
            text: "Acme announced a Series B round.",
            highlights: ["Acme announced a Series B round."],
            highlightScores: [0.9],
            image: "https://news.example.com/acme.png",
          },
          { title: null, url: "https://acme.example.com" },
        ],
        costDollars: { total: 0.005 },
      }),
    );

    const results = await searchExa({ query: "Acme Series B", numResults: 3 });

    expect(results).toEqual([
      {
        title: "Acme raises Series B",
        url: "https://news.example.com/acme",
        publishedDate: "2026-09-01T00:00:00.000Z",
        text: "Acme announced a Series B round.",
        highlights: ["Acme announced a Series B round."],
      },
      { title: "https://acme.example.com", url: "https://acme.example.com" },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("test-exa-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body)).toMatchObject({
      query: "Acme Series B",
      numResults: 3,
    });
  });

  it("throws on a non-OK response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "bad key" }, 401));

    await expect(searchExa({ query: "Acme" })).rejects.toThrow("401");
  });

  it("throws when the response does not match the expected shape", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ title: "x" }] }));

    await expect(searchExa({ query: "Acme" })).rejects.toThrow(
      "unexpected response",
    );
  });

  it("is disabled and never calls Exa without an API key", async () => {
    mockEnv.EXA_API_KEY = undefined;

    expect(isExaSearchEnabled()).toBe(false);
    await expect(searchExa({ query: "Acme" })).rejects.toThrow(
      "not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
