import { describe, expect, it } from "vitest";
import {
  BASELINE_MAIL_ENGINE_CAPABILITIES,
  describeMailEngineCapabilities,
  MAIL_QUERY_FEATURES,
  mailClientSupports,
  parseMailEngineCapabilities,
} from "./capabilities";

describe("parseMailEngineCapabilities", () => {
  it.each([
    ["nothing", undefined],
    ["null", null],
    ["an object", { orders: ["oldest_first"] }],
  ])("treats %s from an engine as the baseline", (_label, reported) => {
    expect(parseMailEngineCapabilities(reported)).toBe(
      BASELINE_MAIL_ENGINE_CAPABILITIES,
    );
  });

  it("keeps features this build doesn't know, so a newer engine's report survives", () => {
    expect(
      parseMailEngineCapabilities([
        "order:newest_first",
        "order:some_future_order",
        "method:someFutureMethod",
      ]),
    ).toEqual([
      "order:newest_first",
      "order:some_future_order",
      "method:someFutureMethod",
    ]);
  });

  it("drops entries that are not features", () => {
    expect(
      parseMailEngineCapabilities([
        "predicate:read",
        42,
        "newest_first",
        "method:x y",
        null,
      ]),
    ).toEqual(["predicate:read"]);
  });
});

describe("mailClientSupports", () => {
  it("assumes the baseline for a client whose engine reported nothing", () => {
    const client = { async queryPersonCard() {} } as never;
    expect(mailClientSupports(client, "order:newest_first")).toBe(true);
    expect(mailClientSupports(client, "predicate:inbox_section")).toBe(true);
    expect(mailClientSupports(client, "order:oldest_first")).toBe(false);
    expect(mailClientSupports(client, "method:queryPersonCard")).toBe(false);
  });

  it("follows what the engine reported", () => {
    const client = {
      capabilities: ["order:oldest_first", "method:queryPersonCard"],
      async queryPersonCard() {},
    } as never;
    expect(mailClientSupports(client, "order:oldest_first")).toBe(true);
    expect(mailClientSupports(client, "order:newest_first")).toBe(false);
    expect(mailClientSupports(client, "method:queryPersonCard")).toBe(true);
  });

  it("needs the client to relay a method the engine reports", () => {
    const client = { capabilities: ["method:queryPersonCard"] } as never;
    expect(mailClientSupports(client, "method:queryPersonCard")).toBe(false);
  });

  it("supports nothing without a client", () => {
    expect(mailClientSupports(null, "order:newest_first")).toBe(false);
  });
});

describe("describeMailEngineCapabilities", () => {
  it("still accepts every query shape engines that predate reporting accept", () => {
    for (const feature of BASELINE_MAIL_ENGINE_CAPABILITIES) {
      expect(MAIL_QUERY_FEATURES).toContain(feature);
    }
  });

  it("lists the optional methods the client answers, and no others", () => {
    const capabilities = describeMailEngineCapabilities({
      async searchMessages() {
        return { messages: [], nextCursor: null } as never;
      },
      queryPersonCard: undefined,
      async close() {},
    });
    expect(capabilities.filter((f) => f.startsWith("method:"))).toEqual([
      "method:searchMessages",
    ]);
    expect(capabilities).toEqual(
      expect.arrayContaining([...MAIL_QUERY_FEATURES]),
    );
  });
});
