import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { extractMainLinks, fetchLinkedPages } from "./linked-pages";

const { mockGetExaContents, mockRedis } = vi.hoisted(() => ({
  mockGetExaContents: vi.fn(),
  mockRedis: {
    get: vi.fn(async (_key: string) => null),
    set: vi.fn(async (_key: string, _value: unknown, _opts?: unknown) => "OK"),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({ redis: mockRedis }));
vi.mock("@/utils/exa/search", () => ({
  isExaSearchEnabled: () => true,
  getExaContents: mockGetExaContents,
}));

const headers = {
  from: "Handshake <notifications@joinhandshake.com>",
  to: "david@example.com",
  subject: "New event",
  date: "2026-10-13T16:00:00Z",
};

describe("extractMainLinks", () => {
  it("keeps the links the email is about and drops the noise around them", () => {
    const links = extractMainLinks({
      headers: {
        ...headers,
        "list-unsubscribe": "<https://mail.joinhandshake.com/u/abc123>",
      },
      textHtml: `
        <a href="https://joinhandshake.com"><img src="https://cdn.joinhandshake.com/logo.png"></a>
        <a href="https://app.joinhandshake.com/login">Ingresar</a>
        <p>Tech & Finance Career Series</p>
        <a href="https://click.joinhandshake.com/ls/click?upn=aGVsbG8">Ver el evento</a>
        <a href="https://app.joinhandshake.com/events/1428571">Ver el evento</a>
        <a href="https://cdn.joinhandshake.com/banner.jpg">Banner</a>
        <a href="https://www.google.com/url?q=https://example.org/page">Redirect</a>
        <a href="https://tracker.example.net/c/Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4">Opaque</a>
        <a href="mailto:events@joinhandshake.com">Escríbenos</a>
        <a href="https://mail.joinhandshake.com/u/abc123">Darse de baja</a>
        <a href="https://joinhandshake.com/unsubscribe?u=1">Unsubscribe</a>
        <a href="https://app.joinhandshake.com/account/notifications">Ajustes</a>
      `,
      textPlain: "",
    });

    expect(links).toEqual(["https://app.joinhandshake.com/events/1428571"]);
  });

  it("puts links with words on them first, and keeps at most two", () => {
    const links = extractMainLinks({
      headers,
      textHtml: `
        <a href="https://example.org/a">https://example.org/a</a>
        <a href="https://example.org/jobs/42">Software Engineer, New Grad</a>
        <a href="https://example.org/docs/guide">The guide</a>
        <a href="https://example.org/blog/post">Our blog</a>
      `,
    });

    expect(links).toEqual([
      "https://example.org/jobs/42",
      "https://example.org/docs/guide",
    ]);
  });

  it("reads links written out in plain text, once each", () => {
    const links = extractMainLinks({
      headers,
      textPlain:
        "RSVP here: https://app.joinhandshake.com/events/1428571. Again: https://app.joinhandshake.com/events/1428571#rsvp",
    });

    expect(links).toEqual(["https://app.joinhandshake.com/events/1428571"]);
  });

  it.each([
    ["a token in the query", "https://app.example.org/verify?token=abc123"],
    ["an OAuth code", "https://partner.example.org/callback?code=4/0AbCdE"],
    ["a meeting passcode", "https://us02web.zoom.us/j/81234567890?pwd=Xy12Ab"],
    ["any other query", "https://docs.example.org/view?id=42"],
    [
      "a token in the fragment",
      "https://app.example.org/welcome#access_token=a1",
    ],
    [
      "a magic-link token in the path",
      "https://app.example.org/magic/7Hq2mZ9xKp4LwR8v",
    ],
    [
      "an invite token in the path",
      "https://team.example.org/join/aB3dE5fG7hJ9kL1mN3pQ",
    ],
    [
      "a UUID in the path",
      "https://app.example.org/invite/3f2b8c1e-9a4d-4e7b-8c2f-1d6a5b9e0c7a",
    ],
    [
      "a hex token in the path",
      "https://app.example.org/verify/9e107d9d372bb6826bd81d3542a419d6",
    ],
    [
      "a long numeric token in the path",
      "https://app.example.org/reset/8301274659120384756",
    ],
    [
      "a hex token split by separators",
      "https://app.example.org/confirm/a1b2c3d4-e5f6a7b8-c9d0e1f2",
    ],
  ])("never sends a link with %s to the crawler", (_, href) => {
    expect(
      extractMainLinks({ headers, textHtml: `<a href="${href}">Open</a>` }),
    ).toEqual([]);
  });

  it("keeps a plain article link, without its campaign tags", () => {
    expect(
      extractMainLinks({
        headers,
        textHtml: `
          <a href="https://news.example.com/2026/10/15/city-council-approves-budget">Read</a>
          <a href="https://blog.example.org/posts/launch-recap?utm_source=newsletter&utm_medium=email">Recap</a>
        `,
      }),
    ).toEqual([
      "https://news.example.com/2026/10/15/city-council-approves-budget",
      "https://blog.example.org/posts/launch-recap",
    ]);
  });

  it("keeps an article whose slug mixes words and numbers", () => {
    const href =
      "https://blog.example.org/posts/top-10-agent-frameworks-of-2026";
    expect(
      extractMainLinks({ headers, textHtml: `<a href="${href}">Guide</a>` }),
    ).toEqual([href]);
  });

  it("keeps another site's login page; only the sender's own is skipped", () => {
    expect(
      extractMainLinks({
        headers,
        textPlain: "https://partner.example.org/login/sso-guide",
      }),
    ).toEqual(["https://partner.example.org/login/sso-guide"]);
  });
});

describe("fetchLinkedPages", () => {
  it("caches pages under a hash of the URL, not the URL itself", async () => {
    const url =
      "https://news.example.com/2026/10/15/city-council-approves-budget";
    mockGetExaContents.mockResolvedValue([{ title: "Budget", text: "Body" }]);

    await fetchLinkedPages({
      message: {
        id: "m1",
        threadId: "t1",
        headers,
        textHtml: `<a href="${url}">Read</a>`,
        textPlain: "",
        internalDate: "1760544000000",
      } as never,
      logger: createTestLogger(),
    });

    const keys = [
      ...mockRedis.get.mock.calls.map(([key]) => key),
      ...mockRedis.set.mock.calls.map(([key]) => key),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain("example.com");
      expect(key).toMatch(/^linked-page:[0-9a-f]{64}$/);
    }
  });
});
