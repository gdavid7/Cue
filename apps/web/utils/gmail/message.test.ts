import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getMessagesBatch,
  hasPreviousCommunicationsWithSenderOrDomain,
  parseMessage,
} from "./message";
import { getBatch } from "@/utils/gmail/batch";
import { createTestLogger } from "@/__tests__/helpers";
import { sleep } from "@/utils/sleep";

vi.mock("@/utils/gmail/batch");
vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("gmail-api-parse-message", () => ({
  default: vi.fn((m) => m),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseMessage", () => {
  // A sender can write their own Authentication-Results lower in the
  // message; the receiving server's verdict is the one it adds on top.
  describe("Authentication-Results", () => {
    const gmail =
      "mx.google.com; dkim=fail header.i=@acme.com; dmarc=fail header.from=acme.com";
    const forged = "mx.google.com; dmarc=pass header.from=acme.com";
    const receivedByGmail = {
      name: "Received",
      value:
        "from mail.acme.com (mail.acme.com. [1.2.3.4]) by mx.google.com with ESMTPS id x1si; Tue, 13 Oct 2026 09:00:00 -0700 (PDT)",
    };

    function parsed(headers: { name: string; value: string }[]) {
      return parseMessage({
        payload: { headers },
        // What gmail-api-parse-message makes of them: the last one wins.
        headers: { from: "nora@acme.com", "authentication-results": forged },
      } as never).headers["authentication-results"];
    }

    it("keeps the topmost one, which Gmail added on receipt", () => {
      expect(
        parsed([
          { name: "Received", value: "by 2002:a05:6a10:1 with SMTP id x" },
          receivedByGmail,
          { name: "Received-SPF", value: "pass (google.com: ...)" },
          { name: "Authentication-Results", value: gmail },
          { name: "From", value: "nora@acme.com" },
          { name: "authentication-results", value: forged },
        ]),
      ).toBe(gmail);
    });

    // Imported, inserted or fetched (POP) mail never passed Gmail's checks;
    // its headers are whatever the original carried.
    it("keeps none when Gmail's servers didn't receive the message", () => {
      expect(
        parsed([
          {
            name: "Received",
            value: "from a by mx.other.example with ESMTP id y",
          },
          { name: "Authentication-Results", value: forged },
        ]),
      ).toBeUndefined();
      expect(
        parsed([{ name: "Authentication-Results", value: forged }]),
      ).toBeUndefined();
    });

    // Gmail fetching from another mailbox records that hop, not a delivery.
    it("keeps none when Gmail fetched the message by POP3, even over a forged delivery", () => {
      expect(
        parsed([
          {
            name: "Received",
            value:
              "from pop.example.com [5.6.7.8] by mx.google.com with POP3 id p1; Tue, 13 Oct 2026",
          },
          receivedByGmail,
          { name: "Authentication-Results", value: forged },
        ]),
      ).toBeUndefined();
      expect(
        parsed([
          {
            name: "Received",
            value: "from imap.example.com by mx.google.com with IMAP id i1",
          },
          { name: "Authentication-Results", value: forged },
        ]),
      ).toBeUndefined();
    });

    it("keeps Gmail's own verdict over a forged Received and Authentication-Results pair below it", () => {
      expect(
        parsed([
          { name: "Received", value: "by 2002:a05:6a10:1 with SMTP id x" },
          receivedByGmail,
          { name: "Authentication-Results", value: gmail },
          { name: "From", value: "nora@acme.com" },
          receivedByGmail,
          { name: "Authentication-Results", value: forged },
        ]),
      ).toBe(gmail);
    });

    it("keeps none when another hop sits between Gmail's delivery and the verdict", () => {
      expect(
        parsed([
          receivedByGmail,
          { name: "Received", value: "from relay.example by relay2.example" },
          { name: "Authentication-Results", value: forged },
        ]),
      ).toBeUndefined();
    });

    it("keeps none when Gmail's Received header comes only below it", () => {
      expect(
        parsed([
          { name: "Authentication-Results", value: forged },
          receivedByGmail,
        ]),
      ).toBeUndefined();
    });
  });

  it("detects calendar MIME parts without decoding their contents in lists", () => {
    const message = parseMessage({
      payload: {
        parts: [
          {
            mimeType: "text/calendar",
            body: {
              data: Buffer.from("BEGIN:VCALENDAR").toString("base64url"),
            },
          },
        ],
      },
    });
    expect(message.isMeetingInvitation).toBe(true);
    expect(message.calendarContent).toBeUndefined();
  });

  it("decodes a single calendar MIME part only when requested", () => {
    const content = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR";
    const message = parseMessage(
      {
        payload: {
          parts: [
            {
              mimeType: "text/calendar",
              body: { data: Buffer.from(content).toString("base64url") },
            },
          ],
        },
      },
      { includeCalendarContent: true },
    );
    expect(message.calendarContent).toBe(content);
  });

  it("rejects multiple calendar MIME parts even across nested alternatives", () => {
    const part = {
      mimeType: "text/calendar",
      body: { data: Buffer.from("BEGIN:VCALENDAR").toString("base64url") },
    };
    const message = parseMessage(
      {
        payload: {
          parts: [part, { mimeType: "multipart/alternative", parts: [part] }],
        },
      },
      { includeCalendarContent: true },
    );
    expect(message.isMeetingInvitation).toBe(false);
    expect(message.calendarContent).toBeUndefined();
  });

  it("keeps large inline images out of the downloadable attachment list", () => {
    const inlineImage = {
      attachmentId: "inline-image",
      filename: "screenshot.png",
      headers: {
        "content-description": "",
        "content-disposition": "inline; filename=screenshot.png",
        "content-id": "<screenshot@inboxzero.local>",
        "content-transfer-encoding": "base64",
        "content-type": "image/png",
      },
      mimeType: "image/png",
      size: 100_000,
    };
    const pdfAttachment = {
      attachmentId: "document",
      filename: "report.pdf",
      headers: {
        "content-description": "",
        "content-disposition": "attachment; filename=report.pdf",
        "content-id": "",
        "content-transfer-encoding": "base64",
        "content-type": "application/pdf",
      },
      mimeType: "application/pdf",
      size: 200_000,
    };

    const message = parseMessage({
      attachments: [inlineImage, pdfAttachment],
      headers: { date: "", subject: "" },
      id: "message-1",
      inline: [],
      threadId: "thread-1",
    } as never);

    expect(message.inline).toEqual([inlineImage]);
    expect(message.attachments).toEqual([pdfAttachment]);
  });
});

describe("getMessagesBatch", () => {
  const logger = createTestLogger();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should retry on retryable 403 error (rate limit)", async () => {
    const messageIds = ["id1"];
    const accessToken = "token";

    // First attempt fails with rate limit
    // Second attempt succeeds
    vi.mocked(getBatch)
      .mockResolvedValueOnce([
        {
          error: {
            code: 403,
            message: "Rate limit exceeded",
            errors: [{ reason: "rateLimitExceeded" }],
            status: "PERMISSION_DENIED",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "id1",
          threadId: "thread1",
          payload: { headers: [] },
        },
      ]);

    const result = await getMessagesBatch({ messageIds, accessToken, logger });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("id1");
    expect(getBatch).toHaveBeenCalledTimes(2);
  });

  it("should not retry on non-retryable 403 error (insufficient permissions)", async () => {
    const messageIds = ["id1"];
    const accessToken = "token";

    vi.mocked(getBatch).mockResolvedValueOnce([
      {
        error: {
          code: 403,
          message: "Insufficient Permission",
          errors: [{ reason: "insufficientPermissions" }],
          status: "PERMISSION_DENIED",
        },
      },
    ]);

    const result = await getMessagesBatch({ messageIds, accessToken, logger });

    expect(result).toHaveLength(0);
    expect(getBatch).toHaveBeenCalledTimes(1);
  });

  it("should retry on generic retryable errors", async () => {
    const messageIds = ["id1"];
    const accessToken = "token";

    vi.mocked(getBatch)
      .mockResolvedValueOnce([
        {
          error: {
            code: 500,
            message: "Internal Server Error",
            errors: [],
            status: "INTERNAL",
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "id1",
          threadId: "thread1",
          payload: { headers: [] },
        },
      ]);

    const result = await getMessagesBatch({ messageIds, accessToken, logger });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("id1");
    expect(getBatch).toHaveBeenCalledTimes(2);
  });

  it("uses conservative sequential initial Gmail batches", async () => {
    const messageIds = Array.from(
      { length: 100 },
      (_, index) => `id${index + 1}`,
    );
    const accessToken = "token";
    let activeBatchRequests = 0;
    let maxActiveBatchRequests = 0;

    vi.mocked(getBatch).mockImplementation(async (ids) => {
      activeBatchRequests++;
      maxActiveBatchRequests = Math.max(
        maxActiveBatchRequests,
        activeBatchRequests,
      );
      await Promise.resolve();
      activeBatchRequests--;

      return ids.map((id) => ({
        id,
        threadId: `${id}-thread`,
        payload: { headers: [] },
      }));
    });

    const result = await getMessagesBatch({ messageIds, accessToken, logger });

    expect(result).toHaveLength(100);
    expect(vi.mocked(getBatch).mock.calls.map(([ids]) => ids.length)).toEqual([
      25, 25, 25, 25,
    ]);
    expect(maxActiveBatchRequests).toBe(1);
  });

  it("retries only rate-limited items in smaller sequential batches", async () => {
    const messageIds = Array.from(
      { length: 55 },
      (_, index) => `id${index + 1}`,
    );
    const accessToken = "token";
    const warnSpy = vi.spyOn(logger, "warn");
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    vi.mocked(getBatch)
      .mockResolvedValueOnce(
        messageIds.slice(0, 25).map((id, index) =>
          index < 10
            ? {
                id,
                threadId: `${id}-thread`,
                payload: { headers: [] },
              }
            : {
                error: {
                  code: 429,
                  message: "Too many concurrent requests for user",
                  errors: [{ reason: "rateLimitExceeded" }],
                  status: "RESOURCE_EXHAUSTED",
                },
              },
        ),
      )
      .mockResolvedValueOnce(
        messageIds.slice(10, 20).map((id) => ({
          id,
          threadId: `${id}-thread`,
          payload: { headers: [] },
        })),
      )
      .mockResolvedValueOnce(
        messageIds.slice(20, 25).map((id) => ({
          id,
          threadId: `${id}-thread`,
          payload: { headers: [] },
        })),
      )
      .mockResolvedValueOnce(
        messageIds.slice(25, 50).map((id) => ({
          id,
          threadId: `${id}-thread`,
          payload: { headers: [] },
        })),
      )
      .mockResolvedValueOnce(
        messageIds.slice(50).map((id) => ({
          id,
          threadId: `${id}-thread`,
          payload: { headers: [] },
        })),
      );

    const result = await getMessagesBatch({ messageIds, accessToken, logger });

    expect(result).toHaveLength(55);
    expect(getBatch).toHaveBeenCalledTimes(5);
    expect(vi.mocked(getBatch).mock.calls.map(([ids]) => ids.length)).toEqual([
      25, 10, 5, 25, 5,
    ]);
    expect(
      warnSpy.mock.calls.filter(
        ([message]) => message === "Retrying Gmail batch items",
      ),
    ).toEqual([
      [
        "Retrying Gmail batch items",
        {
          batchSize: 25,
          rateLimitedItemCount: 15,
          retryableItemCount: 15,
          retryCount: 1,
        },
      ],
    ]);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it("keeps non-rate-limited failures separate from smaller rate-limit retries", async () => {
    const messageIds = Array.from(
      { length: 25 },
      (_, index) => `id${index + 1}`,
    );
    const accessToken = "token";

    vi.mocked(getBatch)
      .mockResolvedValueOnce(
        messageIds.map((id, index) => {
          if (index < 10) {
            return {
              id,
              threadId: `${id}-thread`,
              payload: { headers: [] },
            };
          }

          return {
            error:
              index < 22
                ? {
                    code: 500,
                    message: "Backend error",
                    errors: [{ reason: "backendError" }],
                    status: "INTERNAL",
                  }
                : {
                    code: 429,
                    message: "Too many concurrent requests for user",
                    errors: [{ reason: "rateLimitExceeded" }],
                    status: "RESOURCE_EXHAUSTED",
                  },
          };
        }),
      )
      .mockResolvedValueOnce(
        messageIds.slice(10, 22).map((id) => ({
          id,
          threadId: `${id}-thread`,
          payload: { headers: [] },
        })),
      )
      .mockResolvedValueOnce(
        messageIds.slice(22).map((id) => ({
          id,
          threadId: `${id}-thread`,
          payload: { headers: [] },
        })),
      );

    const result = await getMessagesBatch({ messageIds, accessToken, logger });

    expect(result).toHaveLength(25);
    expect(vi.mocked(getBatch).mock.calls.map(([ids]) => ids)).toEqual([
      messageIds,
      messageIds.slice(10, 22),
      messageIds.slice(22),
    ]);
  });

  it("throws when rate-limited batch items exhaust all retries", async () => {
    const rateLimitError = {
      error: {
        code: 429,
        message: "Too many concurrent requests for user",
        errors: [{ reason: "rateLimitExceeded" }],
        status: "RESOURCE_EXHAUSTED",
      },
    };

    vi.mocked(getBatch)
      .mockResolvedValueOnce([
        {
          id: "id1",
          threadId: "thread1",
          payload: { headers: [] },
        },
        rateLimitError,
      ])
      .mockResolvedValue([rateLimitError]);

    await expect(
      getMessagesBatch({
        messageIds: ["id1", "id2"],
        accessToken: "token",
        logger,
      }),
    ).rejects.toMatchObject({
      message: "Too many concurrent requests for user",
      cause: {
        code: 429,
        errors: [{ reason: "rateLimitExceeded" }],
      },
    });

    expect(getBatch).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});

describe("hasPreviousCommunicationsWithSenderOrDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts prior sent history for public-email senders by searching both from and to", async () => {
    const listMessages = vi.fn().mockResolvedValue({
      data: {
        messages: [
          { id: "current-message", threadId: "thread-1" },
          { id: "prior-sent-message", threadId: "thread-2" },
        ],
      },
    });
    const gmail = {
      users: {
        messages: {
          list: listMessages,
        },
      },
    } as any;
    const date = new Date("2026-04-22T12:34:56.789Z");
    const beforeTimestamp = Math.floor(date.getTime() / 1000);

    const result = await hasPreviousCommunicationsWithSenderOrDomain(gmail, {
      from: "mutual.contact@gmail.com",
      date,
      messageId: "current-message",
    });

    expect(result).toBe(true);
    expect(listMessages).toHaveBeenCalledWith({
      userId: "me",
      maxResults: 4,
      q: `(from:mutual.contact@gmail.com OR to:mutual.contact@gmail.com) before:${beforeTimestamp}`,
      pageToken: undefined,
      labelIds: undefined,
    });
  });

  it("searches company senders by domain and ignores the current message", async () => {
    const listMessages = vi.fn().mockResolvedValue({
      data: {
        messages: [{ id: "current-message", threadId: "thread-1" }],
      },
    });
    const gmail = {
      users: {
        messages: {
          list: listMessages,
        },
      },
    } as any;
    const date = new Date("2026-04-22T12:34:56.789Z");
    const beforeTimestamp = Math.floor(date.getTime() / 1000);

    const result = await hasPreviousCommunicationsWithSenderOrDomain(gmail, {
      from: "introducer@acme.example",
      date,
      messageId: "current-message",
    });

    expect(result).toBe(false);
    expect(listMessages).toHaveBeenCalledWith({
      userId: "me",
      maxResults: 4,
      q: `(from:acme.example OR to:acme.example) before:${beforeTimestamp}`,
      pageToken: undefined,
      labelIds: undefined,
    });
  });
});
