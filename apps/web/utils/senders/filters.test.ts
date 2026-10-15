import { describe, expect, it, vi } from "vitest";
import { NewsletterStatus } from "@/generated/prisma/enums";
import type { EmailFilter, EmailProvider } from "@/utils/email/types";
import { GmailLabel } from "@/utils/gmail/label";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import {
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

    await expect(getEmailFilters(provider, logger)).resolves.toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still reports a real provider failure as an error", async () => {
    const logger = createScopedLogger("test");
    // Silent, so a run with an Axiom token never ships this fake error.
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const provider = {
      getFiltersList: vi.fn().mockRejectedValue(new Error("Backend Error")),
    } as unknown as EmailProvider;

    await expect(getEmailFilters(provider, logger)).resolves.toEqual([]);
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
