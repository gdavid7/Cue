import { describe, it, expect } from "vitest";
import {
  buildComposeReplyRecipients,
  buildReplyAllRecipients,
  formatCcList,
  hasReplyAllRecipients,
  mergeAndDedupeRecipients,
} from "./reply-all";
import type { ParsedMessageHeaders } from "@/utils/types";

describe("buildReplyAllRecipients", () => {
  it("should handle simple reply-all with TO and CC", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "user@company.com, colleague@company.com",
      cc: "manager@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toContain("colleague@company.com");
    expect(result.cc).toHaveLength(3);
  });

  it("should use reply-to header when available", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      "reply-to": "noreply@example.com",
      to: "user@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("noreply@example.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).not.toContain("noreply@example.com");
  });

  it("should handle no CC recipients", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "user@company.com, colleague@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toContain("colleague@company.com");
    expect(result.cc).toHaveLength(2);
  });

  it("should handle single recipient (no CC needed)", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "sender@example.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toHaveLength(0);
  });

  it("should remove duplicates from CC list", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "user@company.com, colleague@company.com",
      cc: "colleague@company.com, manager@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toContain("colleague@company.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toHaveLength(3);
  });

  it("should handle override TO parameter", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "user@company.com",
      cc: "manager@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      "override@example.com",
      "myemail@example.com",
    );

    expect(result.to).toBe("override@example.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).not.toContain("override@example.com");
  });

  it("should handle addresses with extra spaces", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: " user@company.com ,  colleague@company.com ",
      cc: " manager@company.com ",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toContain("colleague@company.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).toHaveLength(3);
  });

  it("should filter out empty addresses", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "user@company.com, , colleague@company.com",
      cc: ", manager@company.com, ",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toContain("colleague@company.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).toHaveLength(3);
  });

  it("should exclude the reply-to address from CC", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "sender@example.com, user@company.com",
      cc: "manager@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).not.toContain("sender@example.com");
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).toHaveLength(2);
  });

  it("should handle email addresses with display names", () => {
    const headers: ParsedMessageHeaders = {
      from: '"John Doe" <john@example.com>',
      to: '"Alice Smith" <alice@company.com>, "Bob Jones" <bob@company.com>',
      cc: '"Charlie Brown" <charlie@company.com>',
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe('"John Doe" <john@example.com>');
    expect(result.cc).toContain("alice@company.com");
    expect(result.cc).toContain("bob@company.com");
    expect(result.cc).toContain("charlie@company.com");
    expect(result.cc).toHaveLength(3);
  });

  it("should deduplicate emails with different display names", () => {
    const headers: ParsedMessageHeaders = {
      from: '"John Doe" <john@example.com>',
      to: '"Alice" <alice@company.com>, "Alice Smith" <alice@company.com>',
      cc: 'alice@company.com, "Ms. Alice" <alice@company.com>',
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe('"John Doe" <john@example.com>');
    expect(result.cc).toContain("alice@company.com");
    expect(result.cc).toHaveLength(1); // All duplicates should be removed
  });

  it("should exclude sender with display name from CC", () => {
    const headers: ParsedMessageHeaders = {
      from: '"John Doe" <john@example.com>',
      to: 'john@example.com, "Alice" <alice@company.com>',
      cc: '"John Doe" <john@example.com>, bob@company.com',
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe('"John Doe" <john@example.com>');
    expect(result.cc).not.toContain("john@example.com");
    expect(result.cc).toContain("alice@company.com");
    expect(result.cc).toContain("bob@company.com");
    expect(result.cc).toHaveLength(2);
  });

  it("should handle mixed email formats", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: '"Alice" <alice@company.com>, bob@company.com',
      cc: 'charlie@company.com, "David Lee" <david@company.com>',
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toContain("alice@company.com");
    expect(result.cc).toContain("bob@company.com");
    expect(result.cc).toContain("charlie@company.com");
    expect(result.cc).toContain("david@company.com");
    expect(result.cc).toHaveLength(4);
  });

  it("should handle override TO with display name format", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "user@company.com",
      cc: "manager@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      '"Override User" <override@example.com>',
      "myemail@example.com",
    );

    expect(result.to).toBe('"Override User" <override@example.com>');
    expect(result.cc).toContain("user@company.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).not.toContain("override@example.com");
    expect(result.cc).toHaveLength(2);
  });

  it("should handle malformed email addresses gracefully", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: '"Invalid" <<double@brackets>>, valid@company.com',
      cc: "not-an-email, real@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).toContain("valid@company.com");
    expect(result.cc).toContain("real@company.com");
    expect(result.cc).not.toContain(""); // Empty strings should be filtered out
    expect(result.cc).toHaveLength(2);
  });

  it("should exclude current user from CC", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "me@mycompany.com, colleague@company.com",
      cc: "manager@company.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "me@mycompany.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).not.toContain("me@mycompany.com");
    expect(result.cc).toContain("colleague@company.com");
    expect(result.cc).toContain("manager@company.com");
    expect(result.cc).toHaveLength(2);
  });

  it("should exclude current user with display name from CC", () => {
    const headers: ParsedMessageHeaders = {
      from: '"Alice" <alice@example.com>',
      to: '"Me" <me@mycompany.com>, "Bob" <bob@company.com>',
      cc: 'me@mycompany.com, "Charlie" <charlie@company.com>',
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      '"My Name" <me@mycompany.com>',
    );

    expect(result.to).toBe('"Alice" <alice@example.com>');
    expect(result.cc).not.toContain("me@mycompany.com");
    expect(result.cc).toContain("bob@company.com");
    expect(result.cc).toContain("charlie@company.com");
    expect(result.cc).toHaveLength(2);
  });

  it("should handle display names with commas correctly", () => {
    const headers: ParsedMessageHeaders = {
      from: '"Smith, John" <john@example.com>',
      to: '"Doe, Jane" <jane@company.com>, "Johnson, Bob" <bob@company.com>',
      cc: '"Williams, Mary" <mary@company.com>, simple@company.com',
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "myemail@example.com",
    );

    expect(result.to).toBe('"Smith, John" <john@example.com>');
    expect(result.cc).toContain("jane@company.com");
    expect(result.cc).toContain("bob@company.com");
    expect(result.cc).toContain("mary@company.com");
    expect(result.cc).toContain("simple@company.com");
    expect(result.cc).toHaveLength(4);
  });

  it("should exclude the current user from CC regardless of address casing", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "User Name <User@Example.com>, colleague@example.com",
      cc: "USER@example.com, manager@example.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(
      headers,
      undefined,
      "user@example.com",
    );

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).not.toContain("User@Example.com");
    expect(result.cc).not.toContain("USER@example.com");
    expect(result.cc).toContain("colleague@example.com");
    expect(result.cc).toContain("manager@example.com");
    expect(result.cc).toHaveLength(2);
  });

  it("should exclude current user aliases from CC", () => {
    const headers: ParsedMessageHeaders = {
      from: "sender@example.com",
      to: "User Alias <alias@example.com>, colleague@example.com",
      cc: "other-alias@example.com, manager@example.com",
      subject: "Test",
      date: "2024-01-01",
    };

    const result = buildReplyAllRecipients(headers, undefined, [
      "primary@example.com",
      "alias@example.com",
      "Other Alias <other-alias@example.com>",
    ]);

    expect(result.to).toBe("sender@example.com");
    expect(result.cc).not.toContain("alias@example.com");
    expect(result.cc).not.toContain("other-alias@example.com");
    expect(result.cc).toEqual(["manager@example.com", "colleague@example.com"]);
  });
});

describe("formatCcList", () => {
  it("should format array of addresses as comma-separated string", () => {
    const addresses = ["user1@example.com", "user2@example.com"];
    const result = formatCcList(addresses);
    expect(result).toBe("user1@example.com, user2@example.com");
  });

  it("should return undefined for empty array", () => {
    const result = formatCcList([]);
    expect(result).toBeUndefined();
  });

  it("should handle single address", () => {
    const result = formatCcList(["user@example.com"]);
    expect(result).toBe("user@example.com");
  });
});

describe("mergeAndDedupeRecipients", () => {
  it("should handle display names correctly", () => {
    const existing = ["john@example.com"];
    const manual = "John Doe <john@example.com>, jane@example.com";
    const result = mergeAndDedupeRecipients(existing, manual);
    expect(result).toEqual(["john@example.com", "jane@example.com"]);
  });

  it("should be case-insensitive", () => {
    const existing = ["john@example.com"];
    const manual = "JOHN@example.com";
    const result = mergeAndDedupeRecipients(existing, manual);
    expect(result).toEqual(["john@example.com"]);
  });

  it("should sanitize empty and invalid entries", () => {
    const existing = ["john@example.com"];
    const manual = " , , invalid-email, jane@example.com";
    const result = mergeAndDedupeRecipients(existing, manual);
    expect(result).toEqual(["john@example.com", "jane@example.com"]);
  });

  it("handles display names with commas", () => {
    const existing = ["john@example.com"];
    const manual =
      '"Doe, Jane" <jane@example.com>, "Smith, Bob" <bob@example.com>';
    const result = mergeAndDedupeRecipients(existing, manual);
    expect(result).toEqual([
      "john@example.com",
      '"Doe, Jane" <jane@example.com>',
      '"Smith, Bob" <bob@example.com>',
    ]);
  });
});

describe("buildComposeReplyRecipients", () => {
  const headers: ParsedMessageHeaders = {
    from: "Dana <dana@example.com>",
    to: "Me <me@example.com>, Alex <alex@example.com>",
    cc: "sam@example.com, ME@example.com",
    subject: "Plans",
    date: "2024-01-01",
  };

  it("replies only to the sender, keeping the original Cc", () => {
    expect(
      buildComposeReplyRecipients({
        headers,
        sentFromUser: false,
        replyAll: false,
        userEmail: "me@example.com",
      }),
    ).toEqual({
      to: "Dana <dana@example.com>",
      cc: "sam@example.com, ME@example.com",
      bcc: "",
    });
  });

  it("copies everyone else on the message except the user for reply all", () => {
    const recipients = buildComposeReplyRecipients({
      headers,
      sentFromUser: false,
      replyAll: true,
      userEmail: "me@example.com",
    });

    expect(recipients.to).toBe("Dana <dana@example.com>");
    expect(recipients.cc.split(", ").sort()).toEqual([
      "alex@example.com",
      "sam@example.com",
    ]);
  });

  it("follows up on the user's own message with its original recipients", () => {
    expect(
      buildComposeReplyRecipients({
        headers: {
          ...headers,
          from: "me@example.com",
          bcc: "hidden@example.com",
        },
        sentFromUser: true,
        replyAll: true,
        userEmail: "me@example.com",
      }),
    ).toEqual({
      to: headers.to,
      cc: headers.cc,
      bcc: "hidden@example.com",
    });
  });
});

describe("hasReplyAllRecipients", () => {
  it("is false for a message only between the sender and the user", () => {
    expect(
      hasReplyAllRecipients(
        {
          from: "dana@example.com",
          to: "Me <me@example.com>",
          subject: "Hi",
          date: "2024-01-01",
        },
        "me@example.com",
      ),
    ).toBe(false);
  });

  it("is true when someone else is on the message", () => {
    expect(
      hasReplyAllRecipients(
        {
          from: "dana@example.com",
          to: "me@example.com",
          cc: "alex@example.com",
          subject: "Hi",
          date: "2024-01-01",
        },
        "me@example.com",
      ),
    ).toBe(true);
  });
});
