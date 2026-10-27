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
        ownEmails: ["me@example.com"],
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
      ownEmails: ["me@example.com"],
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
        ownEmails: ["me@example.com"],
      }),
    ).toEqual({
      to: headers.to,
      cc: headers.cc,
      bcc: "hidden@example.com",
    });
  });
});

describe("buildComposeReplyRecipients across the user's mailboxes (D5)", () => {
  const ownEmails = ["me@work.com", "me@gmail.com"];

  it("drops every connected address from Cc when replying all", () => {
    const recipients = buildComposeReplyRecipients({
      headers: {
        from: "Dana <dana@example.com>",
        to: "me@work.com, Me <ME@gmail.com>",
        cc: "alex@example.com, me@gmail.com",
        subject: "Plans",
        date: "2024-01-01",
      },
      sentFromUser: false,
      replyAll: true,
      ownEmails,
    });

    expect(recipients).toEqual({
      to: "Dana <dana@example.com>",
      cc: "alex@example.com",
      bcc: "",
    });
  });

  it("replies all to everyone else when the user's other mailbox sent it", () => {
    const recipients = buildComposeReplyRecipients({
      headers: {
        from: "Me <me@gmail.com>",
        to: "me@work.com, Alex <alex@example.com>",
        cc: "sam@example.com, me@gmail.com",
        subject: "Plans",
        date: "2024-01-01",
      },
      sentFromUser: false,
      replyAll: true,
      ownEmails,
    });

    expect(recipients).toEqual({
      to: "Alex <alex@example.com>",
      cc: "sam@example.com",
      bcc: "",
    });
  });
});

describe("buildComposeReplyRecipients when only the user was addressed", () => {
  it("promotes Cc to To when the user's other mailbox sent it only to the user", () => {
    expect(
      buildComposeReplyRecipients({
        headers: {
          from: "Me <me@gmail.com>",
          to: "me@work.com",
          cc: "Alex <alex@example.com>, sam@example.com, me@gmail.com",
          subject: "Plans",
          date: "2024-01-01",
        },
        sentFromUser: false,
        replyAll: true,
        ownEmails: ["me@work.com", "me@gmail.com"],
      }),
    ).toEqual({
      to: "alex@example.com, sam@example.com",
      cc: "",
      bcc: "",
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
        ["me@example.com"],
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
        ["me@example.com"],
      ),
    ).toBe(true);
  });

  // D5: the user's other connected mailbox is never someone else to copy.
  it("is false when the only other recipient is the user's other mailbox", () => {
    expect(
      hasReplyAllRecipients(
        {
          from: "dana@example.com",
          to: "me@example.com",
          cc: "Me <me@gmail.com>",
          subject: "Hi",
          date: "2024-01-01",
        },
        ["me@example.com", "me@gmail.com"],
      ),
    ).toBe(false);
  });
});

describe("buildComposeReplyRecipients with Reply-To (FT-30b)", () => {
  const ownEmails = ["me@example.com", "me@gmail.com"];
  const headers: ParsedMessageHeaders = {
    from: "Ana <noreply@supplier.example>",
    "reply-to": "Billing <billing@pay.example>",
    to: "Me <me@example.com>, Alex <alex@example.com>",
    cc: "sam@example.com",
    subject: "Invoice",
    date: "2024-01-01",
  };
  const build = (overrides: Partial<ParsedMessageHeaders>, replyAll: boolean) =>
    buildComposeReplyRecipients({
      headers: { ...headers, ...overrides },
      sentFromUser: false,
      replyAll,
      ownEmails,
    });

  it("replies to the Reply-To address, keeping its name, instead of From", () => {
    expect(build({}, false).to).toBe("Billing <billing@pay.example>");
  });

  it("replies all to Reply-To in place of From, copying everyone else but the user", () => {
    const recipients = build({}, true);
    expect(recipients.to).toBe("Billing <billing@pay.example>");
    expect(recipients.cc.split(", ").sort()).toEqual([
      "alex@example.com",
      "sam@example.com",
    ]);
  });

  it("replies to every Reply-To address, and copies none of them again", () => {
    const recipients = build(
      {
        "reply-to": '"Billing, EU" <billing@pay.example>, ops@pay.example',
        cc: "OPS@pay.example, sam@example.com",
      },
      true,
    );
    expect(recipients.to).toBe(
      '"Billing, EU" <billing@pay.example>, ops@pay.example',
    );
    expect(recipients.cc.split(", ").sort()).toEqual([
      "alex@example.com",
      "sam@example.com",
    ]);
    expect(
      build({ "reply-to": "billing@pay.example, ops@pay.example" }, false).to,
    ).toBe("billing@pay.example, ops@pay.example");
  });

  it("replies to From when the message has no Reply-To", () => {
    expect(build({ "reply-to": undefined }, false).to).toBe(headers.from);
    expect(build({ "reply-to": "" }, true).to).toBe(headers.from);
  });

  it("never replies to the user's own address from Reply-To", () => {
    expect(build({ "reply-to": "Me <ME@gmail.com>" }, false).to).toBe(
      headers.from,
    );
    const recipients = build(
      { "reply-to": "me@example.com, billing@pay.example" },
      true,
    );
    expect(recipients.to).toBe("billing@pay.example");
    expect(recipients.cc.split(", ").sort()).toEqual([
      "alex@example.com",
      "sam@example.com",
    ]);
  });

  it("offers reply all only when someone besides Reply-To and the user is on it", () => {
    expect(
      hasReplyAllRecipients(
        {
          from: "noreply@supplier.example",
          "reply-to": "billing@pay.example",
          to: "me@example.com, billing@pay.example",
          subject: "Invoice",
          date: "2024-01-01",
        },
        ownEmails,
      ),
    ).toBe(false);
  });
});

describe("buildReplyAllRecipients with Reply-To", () => {
  const ownEmails = ["me@example.com"];

  it("replies to a mailing list's Reply-To without copying the list again", () => {
    const recipients = buildReplyAllRecipients(
      {
        from: "Ana <ana@supplier.example>",
        "reply-to": "Team <team@groups.example>",
        to: "me@example.com, Team <TEAM@groups.example>",
        cc: "sam@example.com",
        subject: "Planning",
        date: "2024-01-01",
      },
      undefined,
      ownEmails,
    );
    expect(recipients).toEqual({
      to: "Team <team@groups.example>",
      cc: ["sam@example.com"],
    });
  });

  it("replies to From when every Reply-To entry is malformed", () => {
    const recipients = buildReplyAllRecipients(
      {
        from: "Ana <ana@supplier.example>",
        "reply-to": "undisclosed-recipients:, @@",
        to: "me@example.com, alex@example.com",
        subject: "Planning",
        date: "2024-01-01",
      },
      undefined,
      ownEmails,
    );
    expect(recipients).toEqual({
      to: "Ana <ana@supplier.example>",
      cc: ["alex@example.com"],
    });
  });
});
