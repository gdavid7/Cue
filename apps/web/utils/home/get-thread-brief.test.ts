import { describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailAccountWithAi } from "@/utils/user/get";
import { extractBrief, getThreadBrief } from "./get-thread-brief";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/user/get", () => ({ getEmailAccountWithAi: vi.fn() }));

const message = (textPlain: string) =>
  getMockMessage({
    from: "Sarah Chen <sarah@acme.com>",
    subject: "Renewal",
    textPlain,
  });

describe("extractBrief", () => {
  it("leads with what the latest email asks for", () => {
    const brief = extractBrief([
      message(
        "Hi David,\n\nHope your week is going well. Can you confirm the SSO issue is fixed? Please send the updated pricing before Friday.\n\nThanks,\nSarah",
      ),
    ]);

    expect(brief).toEqual({
      summary:
        "Can you confirm the SSO issue is fixed? Please send the updated pricing before Friday.",
      keyPoints: [],
      source: "extract",
    });
  });

  it("falls back to the opening sentences when nothing is asked", () => {
    expect(
      extractBrief([
        message("The patch shipped last night. All users can sign in again."),
      ])?.summary,
    ).toBe("The patch shipped last night. All users can sign in again.");
  });

  it("returns null for an empty thread", () => {
    expect(extractBrief([])).toBeNull();
  });
});

describe("getThreadBrief", () => {
  it("uses the extract when no AI is available for the account", async () => {
    vi.mocked(getEmailAccountWithAi).mockResolvedValue(null);
    const provider = {
      getThread: vi.fn(async () => ({
        id: "t1",
        snippet: "",
        messages: [message("Can you send the pricing?")],
      })),
    } as unknown as EmailProvider;

    const brief = await getThreadBrief({
      emailAccountId: "a1",
      threadId: "t1",
      emailProvider: provider,
      logger: createTestLogger(),
    });

    expect(brief).toMatchObject({
      summary: "Can you send the pricing?",
      source: "extract",
    });
  });

  it("returns null, rather than failing, when the thread can't be loaded", async () => {
    const provider = {
      getThread: vi.fn().mockRejectedValue(new Error("Not Found")),
    } as unknown as EmailProvider;

    await expect(
      getThreadBrief({
        emailAccountId: "a1",
        threadId: "missing",
        emailProvider: provider,
        logger: createTestLogger(),
      }),
    ).resolves.toBeNull();
  });
});
