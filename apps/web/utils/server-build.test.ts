import { describe, expect, it } from "vitest";
import {
  SERVER_BUILD_HEADER,
  serverBuildHeaderRoutes,
} from "@/utils/server-build";

describe("serverBuildHeaderRoutes", () => {
  it("names the deployment on every mail engine route", () => {
    expect(serverBuildHeaderRoutes("dpl_1")).toEqual([
      {
        source: "/api/mail/v1/:path*",
        headers: [{ key: SERVER_BUILD_HEADER, value: "dpl_1" }],
      },
    ]);
  });

  // Next.js fails the build on a header route with an empty header list.
  it("adds no route at all without a deployment id", () => {
    expect(serverBuildHeaderRoutes(undefined)).toEqual([]);
    expect(serverBuildHeaderRoutes("")).toEqual([]);
  });
});
