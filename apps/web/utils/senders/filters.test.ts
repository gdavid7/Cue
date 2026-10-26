import { describe, expect, it, vi } from "vitest";
import { NewsletterStatus } from "@/generated/prisma/enums";
import type { EmailFilter, EmailProvider } from "@/utils/email/types";
import { GmailLabel } from "@/utils/gmail/label";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import {
  filterNewsletters,
  findNewsletterStatus,
  findSenderLabelFilters,
  getEmailFilters,
} from "./filters";

describe("getEmailFilters", () => {
  it("treats a quota deferral as filters not loaded yet, not an error", async () => {
    const logger = createScopedLogger("test");
    const errorSpy = vi.spyOn(logger, "error");
    const provider = {
      getFiltersList: vi
        .fn()
        // Gaxios wraps what the metered request throws.
        .mockRejectedValue(
          Object.assign(new Error("request failed"), {
            cause: new GmailCallDeferredError(20_000, "background"),
          }),
        ),
    } as unknown as EmailProvider;

    await expect(getEmailFilters(provider, logger)).resolves.toMatchObject({
      filters: [],
      available: false,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns the filters as available when the provider answers", async () => {
    const logger = createScopedLogger("test");
    const filters = [{ id: "f1", criteria: { from: "a@example.com" } }];
    const provider = {
      getFiltersList: vi.fn().mockResolvedValue(filters),
    } as unknown as EmailProvider;

    await expect(getEmailFilters(provider, logger)).resolves.toEqual({
      filters,
      available: true,
    });
  });

  it.each([
    [
      "a Gmail rate limit",
      Object.assign(new Error("User-rate limit exceeded"), { code: 429 }),
      false,
    ],
    [
      "missing Gmail scope",
      Object.assign(new Error("Insufficient Permission"), {
        cause: { errors: [{ reason: "insufficientPermissions" }] },
      }),
      true,
    ],
    ["a revoked grant", new Error("invalid_grant"), true],
    [
      "Outlook throttling",
      Object.assign(new Error("slow down"), { statusCode: 429 }),
      false,
    ],
  ])("logs %s as a warning, not an error, and reports unavailable", async (_name, failure, permanent) => {
    const logger = createScopedLogger("test");
    const errorSpy = vi.spyOn(logger, "error");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const provider = {
      getFiltersList: vi.fn().mockRejectedValue(failure),
    } as unknown as EmailProvider;

    await expect(getEmailFilters(provider, logger)).resolves.toMatchObject({
      filters: [],
      available: false,
      permanent,
      throttled: !permanent,
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("reports a call the Gmail budget deferred as throttled, not permanent", async () => {
    const logger = createScopedLogger("test");
    vi.spyOn(logger, "info").mockImplementation(() => {});
    const provider = {
      getFiltersList: vi
        .fn()
        .mockRejectedValue(
          new GmailCallDeferredError(88_000, "background", "per_minute_budget"),
        ),
    } as unknown as EmailProvider;

    await expect(getEmailFilters(provider, logger)).resolves.toMatchObject({
      available: false,
      permanent: false,
      throttled: true,
    });
  });

  it("still reports a real provider failure as an error", async () => {
    const logger = createScopedLogger("test");
    // Silent, so a run with an Axiom token never ships this fake error.
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const provider = {
      getFiltersList: vi.fn().mockRejectedValue(new Error("Backend Error")),
    } as unknown as EmailProvider;

    await expect(getEmailFilters(provider, logger)).resolves.toMatchObject({
      filters: [],
      available: false,
      permanent: false,
      throttled: false,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "Error getting email filters",
      expect.anything(),
    );
  });
});

describe("findNewsletterStatus", () => {
  it("matches sender addresses case-insensitively", () => {
    expect(
      findNewsletterStatus(
        [
          {
            email: "Sender@Example.COM",
            status: NewsletterStatus.UNSUBSCRIBED,
          },
        ],
        "sender@example.com",
      ),
    ).toBe(NewsletterStatus.UNSUBSCRIBED);
  });

  it("preserves a handled status when a legacy duplicate is unhandled", () => {
    expect(
      findNewsletterStatus(
        [
          { email: "sender@example.com", status: null },
          {
            email: "Sender@Example.COM",
            status: NewsletterStatus.UNSUBSCRIBED,
          },
        ],
        "SENDER@example.com",
      ),
    ).toBe(NewsletterStatus.UNSUBSCRIBED);
  });

  it("does not match invalid sender values", () => {
    expect(
      findNewsletterStatus(
        [
          {
            email: "invalid stored sender",
            status: NewsletterStatus.UNSUBSCRIBED,
          },
        ],
        "invalid message sender",
      ),
    ).toBeUndefined();
  });
});

describe("findSenderLabelFilters", () => {
  it("returns label-only filters for the sender", () => {
    const filters: EmailFilter[] = [
      {
        id: "filter-1",
        criteria: { from: "updates@example.com" },
        action: { addLabelIds: ["Label_123"] },
      },
      {
        id: "filter-2",
        criteria: { from: "other@example.com" },
        action: { addLabelIds: ["Label_456"] },
      },
    ];

    expect(
      findSenderLabelFilters(filters, "Updates <updates@example.com>"),
    ).toEqual([{ id: "filter-1", labelId: "Label_123" }]);
  });

  it("does not return auto-archive filters that also apply a label", () => {
    const filters: EmailFilter[] = [
      {
        id: "archive-filter",
        criteria: { from: "updates@example.com" },
        action: {
          removeLabelIds: [GmailLabel.INBOX],
          addLabelIds: ["Label_123"],
        },
      },
      {
        id: "label-filter",
        criteria: { from: "updates@example.com" },
        action: { addLabelIds: ["Label_456"] },
      },
    ];

    expect(findSenderLabelFilters(filters, "updates@example.com")).toEqual([
      { id: "label-filter", labelId: "Label_456" },
    ]);
  });

  it("matches filters with a display-name sender criterion", () => {
    const filters: EmailFilter[] = [
      {
        id: "filter-1",
        criteria: { from: "Example Updates <updates@example.com>" },
        action: { addLabelIds: ["Label_123"] },
      },
    ];

    expect(findSenderLabelFilters(filters, "updates@example.com")).toEqual([
      { id: "filter-1", labelId: "Label_123" },
    ]);
  });

  it("does not match filters with empty sender criteria", () => {
    const filters: EmailFilter[] = [
      {
        id: "filter-1",
        criteria: { from: "" },
        action: { addLabelIds: ["Label_123"] },
      },
      {
        id: "filter-2",
        criteria: {},
        action: { addLabelIds: ["Label_456"] },
      },
    ];

    expect(findSenderLabelFilters(filters, "updates@example.com")).toEqual([]);
  });

  it("does not match every filter when the sender email is empty", () => {
    const filters: EmailFilter[] = [
      {
        id: "filter-1",
        criteria: { from: "updates@example.com" },
        action: { addLabelIds: ["Label_123"] },
      },
    ];

    expect(findSenderLabelFilters(filters, "")).toEqual([]);
  });
});

describe("filterNewsletters", () => {
  const senders = [
    { name: "none", status: null },
    { name: "approved", status: NewsletterStatus.APPROVED },
  ];

  it("lists senders with no status as unhandled when filters were read", () => {
    expect(
      filterNewsletters(senders, ["unhandled"]).map((sender) => sender.name),
    ).toEqual(["none"]);
  });

  it("does not call a sender unhandled when filters could not be read", () => {
    expect(
      filterNewsletters(senders, ["unhandled"], { filtersAvailable: false }),
    ).toEqual([]);
  });

  it("still lists recorded statuses when filters could not be read", () => {
    expect(
      filterNewsletters(senders, ["approved"], { filtersAvailable: false }).map(
        (sender) => sender.name,
      ),
    ).toEqual(["approved"]);
  });
});
