import { describe, expect, it, vi } from "vitest";
import { onePerIntegration } from "./user-connections";

vi.mock("@/utils/prisma");

describe("onePerIntegration", () => {
  it("keeps one connection per app, the viewed account's own when there is one", () => {
    const connections = [
      {
        id: "drive-personal",
        emailAccountId: "personal",
        integration: { name: "googledrive" },
      },
      {
        id: "drive-school",
        emailAccountId: "school",
        integration: { name: "googledrive" },
      },
      {
        id: "slack-personal",
        emailAccountId: "personal",
        integration: { name: "slack" },
      },
      {
        id: "canvas-other",
        emailAccountId: "other",
        integration: { name: "canvas" },
      },
      {
        id: "canvas-personal",
        emailAccountId: "personal",
        integration: { name: "canvas" },
      },
    ];

    expect(
      onePerIntegration(connections, "school").map(({ id }) => id),
    ).toEqual(["drive-school", "slack-personal", "canvas-other"]);
  });
});
