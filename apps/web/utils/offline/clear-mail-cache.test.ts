import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_PATH, OFFLINE_MAIL_CACHE_PREFIX } from "./mail-cache";
import {
  clearOfflineMailCache,
  clearOfflineMailCacheForAccount,
} from "./clear-mail-cache";

const origin = "https://app.example.com";

function createNamedStorage() {
  const entries = new Map<string, Response>();
  return {
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, response: Response) => {
      entries.set(key, response.clone());
    },
    delete: async (key: string | Request) =>
      entries.delete(typeof key === "string" ? key : key.url),
    keys: async () => [...entries.keys()].map((key) => new Request(key)),
    entries,
  };
}

describe("clearOfflineMailCacheForAccount", () => {
  const mailCache = createNamedStorage();
  const siblingCache = createNamedStorage();
  const cachesByName = new Map<string, ReturnType<typeof createNamedStorage>>();

  beforeEach(() => {
    mailCache.entries.clear();
    siblingCache.entries.clear();
    cachesByName.clear();
    cachesByName.set(`${OFFLINE_MAIL_CACHE_PREFIX}current`, mailCache);
    cachesByName.set("unrelated-cache", siblingCache);
    vi.stubGlobal("window", { location: { origin } });
    vi.stubGlobal("caches", {
      keys: async () => [...cachesByName.keys()],
      open: async (name: string) => {
        const cache = cachesByName.get(name);
        if (!cache) throw new Error(`missing cache ${name}`);
        return cache;
      },
      delete: async (name: string) => cachesByName.delete(name),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deletes every saved mail shell, since removing an account renumbers the rest", async () => {
    await mailCache.put(`${origin}/mail/u/0`, new Response("one"));
    await mailCache.put(`${origin}/mail/u/1`, new Response("two"));
    await mailCache.put(
      `${origin}${ACCOUNT_PATH}`,
      Response.json({ emailAccounts: [{ id: "account-1" }] }),
    );
    await mailCache.put(`${origin}/other`, new Response("keep"));
    await siblingCache.put(`${origin}/mail/u/1`, new Response("keep"));
    await clearOfflineMailCacheForAccount("account-1");
    expect(await mailCache.match(`${origin}/mail/u/0`)).toBeUndefined();
    expect(await mailCache.match(`${origin}/mail/u/1`)).toBeUndefined();
    expect(await mailCache.match(`${origin}${ACCOUNT_PATH}`)).toBeUndefined();
    expect(await (await mailCache.match(`${origin}/other`))?.text()).toBe(
      "keep",
    );
    expect(await (await siblingCache.match(`${origin}/mail/u/1`))?.text()).toBe(
      "keep",
    );
  });

  it("does not touch caches for an escaping account id", async () => {
    await mailCache.put(`${origin}/mail/u/0/inbox`, new Response("one"));
    await clearOfflineMailCacheForAccount("..");
    await clearOfflineMailCacheForAccount("../account-1");
    await clearOfflineMailCacheForAccount("");
    expect(
      await (await mailCache.match(`${origin}/mail/u/0/inbox`))?.text(),
    ).toBe("one");
  });

  it("still deletes every offline mail cache on logout", async () => {
    await mailCache.put(`${origin}/mail/u/1/inbox`, new Response("two"));
    await siblingCache.put("other", new Response("keep"));
    await clearOfflineMailCache();
    expect(cachesByName.has(`${OFFLINE_MAIL_CACHE_PREFIX}current`)).toBe(false);
    expect(cachesByName.has("unrelated-cache")).toBe(true);
    expect(await (await siblingCache.match("other"))?.text()).toBe("keep");
  });
});
