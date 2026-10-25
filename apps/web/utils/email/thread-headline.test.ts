import { describe, expect, it } from "vitest";
import { getMockParsedMessage } from "@/__tests__/mocks/email-provider.mock";
import { pickThreadHeadline } from "@/utils/email/thread-headline";

const isDraft = (message: { labelIds?: string[] }) =>
  message.labelIds?.includes("DRAFT") ?? false;

describe("pickThreadHeadline", () => {
  it("names the other person when the user wrote last", () => {
    const headline = pickThreadHeadline({
      ownEmail: "me@example.com",
      isDraft,
      messages: [
        getMockParsedMessage({
          id: "theirs",
          internalDate: "1000",
          headers: {
            from: "Ada <ada@example.com>",
            to: "me@example.com",
            subject: "Plans",
            date: "",
          },
        }),
        getMockParsedMessage({
          id: "mine",
          internalDate: "2000",
          snippet: "Sounds good",
          headers: {
            from: "Me <ME@example.com>",
            to: "ada@example.com",
            subject: "Re: Plans",
            date: "",
          },
        }),
      ],
    });

    expect(headline).toEqual({
      subject: "Re: Plans",
      from: "Ada <ada@example.com>",
      snippet: "Sounds good",
    });
  });

  it("falls back to the user when only they wrote, and skips drafts", () => {
    const headline = pickThreadHeadline({
      ownEmail: "me@example.com",
      isDraft,
      messages: [
        getMockParsedMessage({
          internalDate: "1000",
          headers: { from: "me@example.com", to: "", subject: "Hi", date: "" },
        }),
        getMockParsedMessage({
          internalDate: "3000",
          labelIds: ["DRAFT"],
          headers: {
            from: "me@example.com",
            to: "",
            subject: "Draft",
            date: "",
          },
        }),
      ],
    });

    expect(headline?.subject).toBe("Hi");
    expect(headline?.from).toBe("me@example.com");
  });

  it("is null for a conversation of drafts only", () => {
    expect(
      pickThreadHeadline({
        ownEmail: "me@example.com",
        isDraft,
        messages: [getMockParsedMessage({ labelIds: ["DRAFT"] })],
      }),
    ).toBeNull();
  });
});
