import { describe, expect, it } from "vitest";
import {
  getLegacyHostRedirects,
  LEGACY_PAGE_SOURCE,
} from "@/utils/legacy-host";
import { SEMANTIC_MODEL } from "@/utils/mail-search/semantic-embedding";

describe("getLegacyHostRedirects", () => {
  it("builds one permanent redirect gated to the old hosts", () => {
    const [redirect, ...rest] = getLegacyHostRedirects("https://cuemail.tech");

    expect(rest).toEqual([]);
    expect(redirect.permanent).toBe(true);
    expect(redirect.destination).toBe("https://cuemail.tech/:path");
    expect(redirect.has).toEqual([
      {
        type: "host",
        value: "cue-inbox\\.vercel\\.app|cue-ten-blue\\.vercel\\.app",
      },
    ]);
    const hostPattern = new RegExp(`^(?:${redirect.has[0].value})$`);
    expect(hostPattern.test("cue-inbox.vercel.app")).toBe(true);
    expect(hostPattern.test("cue-ten-blue.vercel.app")).toBe(true);
    expect(hostPattern.test("cue-git-feature-team.vercel.app")).toBe(false);
    expect(hostPattern.test("localhost")).toBe(false);
  });

  it("adds nothing when the base URL is unset, invalid or itself a legacy host", () => {
    expect(getLegacyHostRedirects(undefined)).toEqual([]);
    expect(getLegacyHostRedirects("not a url")).toEqual([]);
    expect(getLegacyHostRedirects("https://cue-inbox.vercel.app")).toEqual([]);
  });
});

describe("legacy page source", () => {
  // Next compiles "/:path(<pattern>)" with path-to-regexp; the custom pattern
  // is the whole contract, so it is matched here against the path after "/".
  const pattern = new RegExp(
    `^${LEGACY_PAGE_SOURCE.slice("/:path(".length, -1)}$`,
  );
  const matches = (pathname: string) => pattern.test(pathname.slice(1));

  it.each([
    "/",
    "/pricing",
    "/login",
    "/mail/u/0/inbox",
    "/mail/u/0/inbox/a.b",
    "/mail/u/0/label/Label_1.2",
    "/apiary",
  ])("redirects page %s", (pathname) => {
    expect(matches(pathname)).toBe(true);
  });

  it.each([
    "/api/google/webhook",
    "/_next/static/chunks/a.js",
    "/monitoring",
    "/monitoring/x",
    "/.well-known/openid-configuration",
    "/sw.js",
    "/robots.txt",
    "/icons/icon-192x192.png",
    `/models/${SEMANTIC_MODEL.repository}/${SEMANTIC_MODEL.revision}/onnx/model_quantized.onnx`,
    `/models/${SEMANTIC_MODEL.repository}/${SEMANTIC_MODEL.revision}/tokenizer.json`,
  ])("leaves %s on the old host", (pathname) => {
    expect(matches(pathname)).toBe(false);
  });
});
