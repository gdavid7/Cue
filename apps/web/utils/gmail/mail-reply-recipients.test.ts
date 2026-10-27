import type { gmail_v1 } from "@googleapis/gmail";
import { assert, describe, expect, it, vi } from "vitest";
import type { EmailForAction } from "@/utils/ai/types";
import { draftEmail, replyToEmail } from "./mail";

vi.mock("@/utils/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/mail")>()),
  ensureEmailSendingEnabled: vi.fn(),
}));

const ownEmails = ["me@example.com", "me@alias.example"];
const original = (headers: Partial<EmailForAction["headers"]>) =>
  ({
    id: "message-1",
    threadId: "thread-1",
    headers: {
      from: "Ana Lopez <ana@supplier.example>",
      to: "me@example.com",
      subject: "Original subject",
      date: "Mon, 1 Jan 2024 11:00:00 +0000",
      "message-id": "<message-1@supplier.example>",
      ...headers,
    },
    textPlain: "Original body",
    textHtml: "<p>Original body</p>",
  }) as EmailForAction;

describe("Gmail draftEmail recipients", () => {
  it("addresses every Reply-To address instead of From", async () => {
    const mime = await draftMime({
      "reply-to": "Billing <billing@pay.example>, ops@pay.example",
      cc: "sam@example.com",
    });
    expect(header(mime, "To")).toBe(
      "Billing <billing@pay.example>, ops@pay.example",
    );
    expect(header(mime, "Cc")).toBe("sam@example.com");
  });

  it("keeps a mailing list that asks for replies on the reply", async () => {
    const mime = await draftMime({
      to: "me@example.com, Team <team@groups.example>",
      "reply-to": "Team <team@groups.example>",
    });
    expect(header(mime, "To")).toBe("Team <team@groups.example>");
    expect(header(mime, "Cc")).toBeUndefined();
  });

  it("answers From when there is no usable Reply-To", async () => {
    expect(header(await draftMime({}), "To")).toBe(
      "Ana Lopez <ana@supplier.example>",
    );
    expect(
      header(await draftMime({ "reply-to": "Me <ME@alias.example>" }), "To"),
    ).toBe("Ana Lopez <ana@supplier.example>");
  });
});

describe("Gmail replyToEmail recipients", () => {
  it("replies to Reply-To instead of From", async () => {
    const mime = await replyMime({ "reply-to": "billing@pay.example" });
    expect(header(mime, "To")).toBe("billing@pay.example");
  });

  it("replies to From when Reply-To names only the user's own alias", async () => {
    const mime = await replyMime({ "reply-to": "Me <me@alias.example>" });
    expect(header(mime, "To")).toBe("Ana Lopez <ana@supplier.example>");
  });
});

async function draftMime(headers: Partial<EmailForAction["headers"]>) {
  const create = vi.fn().mockResolvedValue({ data: { id: "draft-1" } });
  const gmail = {
    users: { drafts: { create } },
  } as unknown as gmail_v1.Gmail;
  await draftEmail(gmail, original(headers), { content: "Thanks" }, ownEmails);
  const call = create.mock.calls.at(-1);
  assert.isDefined(call);
  return decode(call[0].requestBody.message.raw);
}

async function replyMime(headers: Partial<EmailForAction["headers"]>) {
  const send = vi
    .fn()
    .mockResolvedValue({ data: { id: "sent-1", threadId: "thread-1" } });
  const gmail = {
    users: { messages: { send } },
  } as unknown as gmail_v1.Gmail;
  await replyToEmail(gmail, original(headers), "Thanks", "me@example.com", {
    ownEmails,
  });
  const call = send.mock.calls.at(-1);
  assert.isDefined(call);
  return decode(call[0].requestBody.raw);
}

function decode(raw: string) {
  return Buffer.from(raw, "base64url").toString();
}

function header(mime: string, name: string) {
  const headerBlock = mime.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  const match = headerBlock.match(new RegExp(`^${name}: (.*)$`, "im"));
  return match?.[1];
}
