import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { describe, expect, it } from "vitest";
import { rankCueFoundThreads } from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
import { conversationSummaryToListThread } from "@/utils/mail-engine/list-thread";

const NOW = new Date("2026-10-19T17:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const NEWSLETTER_LABEL = { id: "Label_7", name: "Newsletter" };

describe("rankCueFoundThreads", () => {
  it("puts mail whose subject names the search above newer mail that only mentions it", () => {
    const ranked = rank("(dentist OR dental) appointment", [
      thread("tips", {
        daysAgo: 1,
        subject: "Five habits for healthy teeth",
        preview: "Book a dentist appointment twice a year",
      }),
      thread("reminder", {
        daysAgo: 20,
        subject: "Your dental appointment on Nov 5",
      }),
    ]);
    expect(ranked).toEqual(["reminder", "tips"]);
  });

  it("puts mail matching more of the search first", () => {
    const ranked = rank("lemon chicken", [
      thread("tart", { daysAgo: 2, subject: "Lemon tart" }),
      thread("recipe", { daysAgo: 40, subject: "Lemon chicken, as promised" }),
    ]);
    expect(ranked).toEqual(["recipe", "tart"]);
  });

  it("puts promotions, spam and mail Cue sorts as newsletters below the rest", () => {
    const ranked = rank("conference talk", [
      thread("promo", {
        daysAgo: 1,
        subject: "Conference talk passes: 30% off",
        labelIds: ["CATEGORY_PROMOTIONS"],
      }),
      thread("digest", {
        daysAgo: 2,
        subject: "This week: conference talk recordings",
        labelIds: [NEWSLETTER_LABEL.id],
      }),
      thread("spam", {
        daysAgo: 3,
        subject: "Conference talk prize",
        labelIds: ["SPAM"],
      }),
      thread("invite", {
        daysAgo: 60,
        subject: "Conference talk invitation",
      }),
    ]);
    expect(ranked[0]).toBe("invite");
  });

  it("keeps promotions in place when the search asks for them or for their sender", () => {
    const promo = thread("promo", {
      daysAgo: 1,
      from: "Skyline Air <deals@skyline.example>",
      subject: "Fare sale",
      labelIds: ["CATEGORY_PROMOTIONS"],
    });
    const receipt = thread("receipt", {
      daysAgo: 30,
      from: "Skyline Air <reservations@skyline.example>",
      subject: "Fare receipt",
    });
    expect(rank("from:skyline fare", [promo, receipt])).toEqual([
      "promo",
      "receipt",
    ]);
    expect(rank("category:promotions fare", [promo, receipt])).toEqual([
      "promo",
      "receipt",
    ]);
  });

  it("prefers mail meeting the search's conditions and dates, which a wider search may not", () => {
    const after = Math.floor((NOW.getTime() - 30 * DAY_MS) / 1000);
    const ranked = rank(`from:tom has:attachment after:${after}`, [
      thread("note", { daysAgo: 1, from: "Tom <tom@example.com>" }),
      thread("old-sheet", {
        daysAgo: 90,
        from: "Tom <tom@example.com>",
        hasAttachments: true,
      }),
      thread("sheet", {
        daysAgo: 10,
        from: "Tom <tom@example.com>",
        hasAttachments: true,
      }),
    ]);
    expect(ranked).toEqual(["sheet", "note", "old-sheet"]);
  });

  it("breaks ties by recency", () => {
    const ranked = rank("invoice", [
      thread("march", { daysAgo: 200, subject: "Invoice" }),
      thread("october", { daysAgo: 5, subject: "Invoice" }),
    ]);
    expect(ranked).toEqual(["october", "march"]);
  });

  it("matches words from their start as the store does, in scripts written with and without spaces", () => {
    const ranked = rank("(contrato OR 見積)", [
      thread("other", { daysAgo: 1, subject: "Subcontratos pendientes" }),
      thread("es", { daysAgo: 5, subject: "El contrato firmado" }),
      thread("ja", { daysAgo: 6, subject: "お見積書の送付" }),
      thread("none", { daysAgo: 2, subject: "Nada que ver" }),
    ]);
    expect(ranked).toEqual(["es", "ja", "other", "none"]);
  });
});

function rank(search: string, threads: ReturnType<typeof thread>[]) {
  return rankCueFoundThreads(threads, {
    searches: [search],
    labels: [NEWSLETTER_LABEL],
    now: NOW,
    timeZone: "UTC",
    provider: "google",
  }).map((row) => row.id);
}

function thread(
  id: string,
  {
    daysAgo,
    subject = "",
    preview = "",
    from = "Someone <someone@example.com>",
    labelIds = [],
    hasAttachments = false,
  }: {
    daysAgo: number;
    subject?: string;
    preview?: string;
    from?: string;
    labelIds?: string[];
    hasAttachments?: boolean;
  },
) {
  const summary: ConversationSummary = {
    key: { accountId: "account", conversationId: id },
    subject,
    preview,
    from,
    to: "Me <me@example.com>",
    senders: [from],
    latestMessageAtMs: NOW.getTime() - daysAgo * DAY_MS,
    unread: false,
    starred: false,
    labelIds,
    roles: labelIds.includes("SPAM") ? ["spam"] : ["inbox"],
    pendingOperationIds: [],
    hasAttachments,
  };
  return conversationSummaryToListThread(summary);
}
