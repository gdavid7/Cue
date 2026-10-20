import { describe, expect, it } from "vitest";
import { messageEmbeddingText } from "@/utils/mail-search/semantic-embedding";

describe("messageEmbeddingText", () => {
  it("joins subject, sender name and body, without the address", () => {
    expect(
      messageEmbeddingText({
        subject: "Kitchen remodel proposal",
        from: '"Ben Alvarez" <ben@remodel.example>',
        body: "Hi Alex,\n\n attached is the proposal.",
      }),
    ).toBe(
      "Kitchen remodel proposal. Ben Alvarez. Hi Alex, attached is the proposal.",
    );
  });
});
