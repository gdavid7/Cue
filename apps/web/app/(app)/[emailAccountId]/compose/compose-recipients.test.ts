import { describe, expect, it } from "vitest";
import {
  findInvalidPendingRecipientField,
  normalizePastedRecipients,
  resolveComposeRecipientFields,
  resolveComposeRecipients,
  resolveRecipientSelection,
} from "./compose-recipients";

describe("resolveRecipientSelection", () => {
  it("commits the selected recipients", () => {
    expect(
      resolveRecipientSelection(["first@example.com", "second@example.com"]),
    ).toBe("first@example.com,second@example.com");
  });

  it("clears the selection when the sole recipient is deselected", () => {
    expect(resolveRecipientSelection([])).toBe("");
  });

  it("commits a picked suggestion that carries a display name", () => {
    expect(
      resolveRecipientSelection([
        "first@example.com",
        '"Lovelace, Ada" <ada@example.com>',
      ]),
    ).toBe('first@example.com,"Lovelace, Ada" <ada@example.com>');
  });

  it("ignores a selection ending in an incomplete search query", () => {
    expect(
      resolveRecipientSelection(["first@example.com", "second@"]),
    ).toBeNull();
  });
});

describe("resolveComposeRecipients", () => {
  it("commits a valid recipient that is still in the contact search input", () => {
    expect(
      resolveComposeRecipients({
        selectedRecipients: undefined,
        pendingRecipient: "recipient@example.com",
      }),
    ).toBe("recipient@example.com");
  });

  it("appends the pending recipient to committed recipients", () => {
    expect(
      resolveComposeRecipients({
        selectedRecipients: "first@example.com",
        pendingRecipient: " second@example.com ",
      }),
    ).toBe("first@example.com,second@example.com");
  });

  it("does not re-add a recipient already present with a display name", () => {
    expect(
      resolveComposeRecipients({
        selectedRecipients: '"Doe, John" <john@example.com>',
        pendingRecipient: "John@example.com",
      }),
    ).toBe('"Doe, John" <john@example.com>');
  });

  it("preserves pasted comma-separated recipients and quoted display names", () => {
    expect(
      resolveComposeRecipients({
        selectedRecipients: "first@example.com",
        pendingRecipient:
          '"Doe, Jane" <jane@example.com>, second@example.com, FIRST@example.com',
      }),
    ).toBe(
      'first@example.com,"Doe, Jane" <jane@example.com>,second@example.com',
    );
  });

  it("does not partially commit a pasted list containing unfinished search text", () => {
    expect(
      resolveComposeRecipients({
        selectedRecipients: "first@example.com",
        pendingRecipient: "second@example.com, unfinished",
      }),
    ).toBe("first@example.com");
  });

  it("does not send incomplete contact search text", () => {
    expect(
      resolveComposeRecipients({
        selectedRecipients: "first@example.com",
        pendingRecipient: "second@",
      }),
    ).toBe("first@example.com");
  });

  it("commits pending contact entries from every recipient field", () => {
    expect(
      resolveComposeRecipientFields({
        selectedRecipients: {
          to: "to@example.com",
          cc: "first-cc@example.com",
          bcc: undefined,
        },
        pendingRecipients: {
          to: "",
          cc: "second-cc@example.com",
          bcc: "bcc@example.com",
        },
      }),
    ).toEqual({
      to: "to@example.com",
      cc: "first-cc@example.com,second-cc@example.com",
      bcc: "bcc@example.com",
    });
  });
});

describe("findInvalidPendingRecipientField", () => {
  it("names the first field holding typed text that isn't an address", () => {
    expect(
      findInvalidPendingRecipientField({ to: "bob@exmaple", cc: "", bcc: "" }),
    ).toBe("to");
    expect(
      findInvalidPendingRecipientField({
        to: "bob@example.com",
        cc: "  ",
        bcc: "sam@example.com, half",
      }),
    ).toBe("bcc");
  });

  it("lets a send through when typed text is empty or valid", () => {
    expect(
      findInvalidPendingRecipientField({
        to: '"Doe, Jane" <jane@example.com>',
        cc: "",
        bcc: " ",
      }),
    ).toBeNull();
  });

  it("checks only the address part of a named recipient", () => {
    expect(
      findInvalidPendingRecipientField({
        to: '"Lovelace, Ada" <ada@exmaple>',
        cc: "",
        bcc: "",
      }),
    ).toBe("to");
    expect(
      findInvalidPendingRecipientField({
        to: "Zoë Ångström <zoe@example.com>",
        cc: "",
        bcc: "",
      }),
    ).toBeNull();
  });
});

describe("normalizePastedRecipients", () => {
  it("splits on commas, semicolons and lines but not inside quoted names", () => {
    expect(
      normalizePastedRecipients(
        '"Doe; John" <j@x.com>;k@x.com\nl@x.com\r\n, m@x.com;',
      ),
    ).toBe('"Doe; John" <j@x.com>, k@x.com, l@x.com, m@x.com');
  });
});
