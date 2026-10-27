import { describe, expect, it } from "vitest";
import { parseMessage, GMAIL_METADATA_HEADERS } from "./message";
import { parsedMessageMetadata } from "@/utils/mail-api/observations";

describe("Gmail Reply-To ingest", () => {
  it("stores the Reply-To header's addresses on the message", () => {
    const parsed = parseMessage({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX"],
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Ana <noreply@supplier.example>" },
          { name: "To", value: "me@example.com" },
          { name: "Reply-To", value: "Billing <billing@pay.example>" },
          { name: "Subject", value: "Invoice" },
        ],
        body: { size: 0 },
      },
    });

    expect(parsedMessageMetadata(parsed).replyTo).toEqual([
      "Billing <billing@pay.example>",
    ]);
  });

  it("asks for Reply-To on metadata reads, which sync stores from", () => {
    expect(GMAIL_METADATA_HEADERS).toContain("Reply-To");
  });
});
