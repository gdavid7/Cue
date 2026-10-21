import { describe, expect, it } from "vitest";
import { getLegacyHostRedirect } from "@/utils/legacy-host";

const baseUrl = "https://cuemail.tech";

function redirect(host: string | null, pathname: string, search = "") {
  return getLegacyHostRedirect({ host, pathname, search, baseUrl });
}

describe("getLegacyHostRedirect", () => {
  it("sends pages on the old hosts to the same path and query on the new domain", () => {
    expect(redirect("cue-inbox.vercel.app", "/")).toBe("https://cuemail.tech/");
    expect(
      redirect("cue-ten-blue.vercel.app", "/mail/u/0/inbox", "?q=a%20b"),
    ).toBe("https://cuemail.tech/mail/u/0/inbox?q=a%20b");
  });

  it.each([
    "/api/google/webhook",
    "/api/outlook/webhook",
    "/_next/static/chunks/a.js",
    "/monitoring",
    "/.well-known/openid-configuration",
    "/sw.js",
    "/icons/icon-192x192.png",
    "/manifest.webmanifest",
  ])("leaves %s where it is", (pathname) => {
    expect(redirect("cue-inbox.vercel.app", pathname)).toBeNull();
  });

  it("never redirects previews, localhost or the new host", () => {
    expect(redirect("cue-git-feature-team.vercel.app", "/")).toBeNull();
    expect(redirect("localhost:3000", "/")).toBeNull();
    expect(redirect("cuemail.tech", "/")).toBeNull();
    expect(redirect(null, "/")).toBeNull();
  });

  it("does not redirect when the base URL is the request host or unset", () => {
    expect(
      getLegacyHostRedirect({
        host: "cue-inbox.vercel.app",
        pathname: "/",
        search: "",
        baseUrl: "https://cue-inbox.vercel.app",
      }),
    ).toBeNull();
    expect(
      getLegacyHostRedirect({
        host: "cue-inbox.vercel.app",
        pathname: "/",
        search: "",
        baseUrl: undefined,
      }),
    ).toBeNull();
  });
});
