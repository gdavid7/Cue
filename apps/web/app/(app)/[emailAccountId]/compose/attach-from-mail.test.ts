import { describe, expect, it } from "vitest";
import {
  attachFromMailSenders,
  toComposeFile,
} from "@/app/(app)/[emailAccountId]/compose/attach-from-mail";

describe("attachFromMailSenders", () => {
  it("lists each recipient across To, Cc and Bcc once, in order", () => {
    expect(
      attachFromMailSenders({
        fields: [
          "Ana Lima <Ana@Example.com>, bo@example.com",
          "ana@example.com",
          '"Lee, Cy" <cy@example.com>',
        ],
        ownAddresses: [],
      }),
    ).toEqual([
      { email: "ana@example.com", label: "Ana Lima" },
      { email: "bo@example.com", label: "bo@example.com" },
      { email: "cy@example.com", label: "Lee, Cy" },
    ]);
  });

  it("leaves out the user's own addresses, blanks and anything not an address", () => {
    expect(
      attachFromMailSenders({
        fields: [
          "me@example.com, , not an address",
          undefined,
          "bo@example.com",
        ],
        ownAddresses: ["Me@example.com"],
      }),
    ).toEqual([{ email: "bo@example.com", label: "bo@example.com" }]);
  });

  it("keeps the first few recipients so the picker stays short", () => {
    const fields = [
      Array.from({ length: 6 }, (_, index) => `p${index}@example.com`).join(
        ",",
      ),
    ];
    expect(
      attachFromMailSenders({ fields, ownAddresses: [] }).map(
        (sender) => sender.email,
      ),
    ).toEqual(["p0@example.com", "p1@example.com", "p2@example.com"]);
  });
});

describe("toComposeFile", () => {
  it("names the file as in the mail and keeps the stored type over a generic one", () => {
    const file = toComposeFile(
      new Blob(["%PDF"], { type: "application/octet-stream" }),
      { filename: "contract.pdf", mimeType: "application/pdf" },
    );
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("contract.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(4);
  });

  it("falls back to the downloaded type when the mail stored none", () => {
    const file = toComposeFile(new Blob(["x"], { type: "text/plain" }), {
      filename: "notes",
      mimeType: "",
    });
    expect(file.type).toBe("text/plain");
  });
});
