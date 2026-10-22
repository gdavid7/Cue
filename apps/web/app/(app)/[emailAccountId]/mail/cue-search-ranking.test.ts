import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { describe, expect, it } from "vitest";
import {
  rankCueFoundThreads,
  rankWithWidened,
  searchedWords,
} from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
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

describe("rankWithWidened", () => {
  const search = "(conference OR summit) (talk OR invitation)";
  const invite = thread("invite", {
    daysAgo: 60,
    subject: "Invitation to speak at DevSummit",
  });

  it("lets a wider tier's better fit pass a promotion the first search found", () => {
    const promo = thread("promo", {
      daysAgo: 1,
      subject: "Conference talk recordings",
      labelIds: ["CATEGORY_PROMOTIONS"],
    });
    expect(ids(rankWithWidened([promo], [invite], context(search)))).toEqual([
      "invite",
      "promo",
    ]);
  });

  it("keeps the first search's other matches ahead of anything a tier found", () => {
    const weak = thread("weak", {
      daysAgo: 1,
      subject: "Notes",
      preview: "the conference talk",
    });
    const strong = thread("strong", {
      daysAgo: 2,
      subject: "Conference talk invitation",
    });
    expect(ids(rankWithWidened([weak], [strong], context(search)))).toEqual([
      "weak",
      "strong",
    ]);
  });
});

describe("rankWithWidened with the search by meaning", () => {
  const search = "contractor kitchen invoice";
  const primaryMatch = thread("cookbook", {
    daysAgo: 1,
    subject: "Kitchen invoice for your cookbook order",
  });
  const proposal = thread("proposal", {
    daysAgo: 30,
    subject: "Kitchen remodel proposal",
    from: "Ben (Remodeling) <ben@remodel.example>",
  });

  it("puts mail the model finds clearly close right after the first search's matches, and above one it demotes", () => {
    const ranked = rankWithWidened(
      [primaryMatch],
      [],
      withSimilarity(search, { proposal: 0.7 }),
      [proposal],
    );
    expect(ids(ranked)).toEqual(["cookbook", "proposal"]);
    const demotedMatch = thread("deal", {
      daysAgo: 1,
      subject: "Kitchen invoice template sale",
      labelIds: ["CATEGORY_PROMOTIONS"],
    });
    expect(
      ids(
        rankWithWidened(
          [demotedMatch],
          [],
          withSimilarity(search, { proposal: 0.7 }),
          [proposal],
        ),
      ),
    ).toEqual(["proposal", "deal"]);
  });

  it("keeps mail only loosely close after the first search's matches", () => {
    const loose = thread("loose", {
      daysAgo: 2,
      subject: "Kitchen remodel ideas",
    });
    const close = thread("close", { daysAgo: 90, subject: "Remodel quote" });
    const ranked = rankWithWidened(
      [primaryMatch],
      [],
      withSimilarity(search, { loose: 0.32, close: 0.38 }),
      [loose, close],
    );
    expect(ids(ranked)).toEqual(["cookbook", "loose", "close"]);
  });

  it("leaves the first search's matches in their order, however close each is", () => {
    const newer = thread("newer", { daysAgo: 1, subject: "Kitchen invoice" });
    const older = thread("older", { daysAgo: 9, subject: "Kitchen invoice" });
    expect(
      ids(
        rankWithWidened(
          [older, newer],
          [],
          withSimilarity(search, { older: 0.9, newer: 0.2 }),
          [older, newer],
        ),
      ),
    ).toEqual(["newer", "older"]);
  });

  it("keeps the first search's matches ahead of a wider tier's match however close the model finds it", () => {
    const exact = thread("exact", {
      daysAgo: 30,
      subject: "Renewal",
      preview: "Your contract is attached",
    });
    const close = thread("close", {
      daysAgo: 1,
      subject: "Acme contract signed",
    });
    expect(
      ids(
        rankWithWidened(
          [exact],
          [close],
          withSimilarity("contract renewal", { close: 0.7 }),
        ),
      ),
    ).toEqual(["exact", "close"]);
    expect(
      ids(
        rankWithWidened(
          [exact],
          [],
          withSimilarity("contract renewal", { close: 0.7 }),
          [close],
        ),
      ),
    ).toEqual(["exact", "close"]);
  });

  it("leads with what a wider tier found when the model finds it clearly close too, above mail found by meaning alone", () => {
    // Nothing has every word, so the confirmation is a tier's match on one
    // group; the boarding pass shares only meaning. Words and meaning
    // together outweigh meaning alone.
    const confirmation = thread("confirmation", {
      daysAgo: 20,
      subject: "Your Skyline Air confirmation: SFO to DEN",
    });
    const boarding = thread("boarding", {
      daysAgo: 5,
      subject: "Your boarding pass: SFO to DEN",
    });
    expect(
      ids(
        rankWithWidened(
          [],
          [confirmation],
          withSimilarity("flight (confirmation OR itinerary)", {
            confirmation: 0.5,
            boarding: 0.6,
          }),
          [boarding],
        ),
      ),
    ).toEqual(["confirmation", "boarding"]);
  });

  it("orders a wider tier's matches by how close the model finds them when their words fit alike", () => {
    // The same Lisbon match in both previews: only meaning tells the flight
    // from the newer hotel stay.
    const flight = thread("flight", {
      daysAgo: 3,
      subject: "Your Skyline Air confirmation: SFO to LIS",
      preview: "Depart Aug 14, arrive Lisbon Aug 15",
    });
    const hotel = thread("hotel", {
      daysAgo: 2,
      subject: "Booking confirmed: Casa Alfama Hotel",
      preview: "Thank you for booking Casa Alfama Hotel in Lisbon",
    });
    expect(
      ids(
        rankWithWidened(
          [],
          [hotel, flight],
          withSimilarity("(vol OR flight) (Lisbonne OR Lisbon)", {
            flight: 0.54,
            hotel: 0.51,
          }),
        ),
      ),
    ).toEqual(["flight", "hotel"]);
  });

  it("drops mail found by meaning alone that misses the search's sender or dates", () => {
    const fromBen = "from:ben kitchen after:2026/09/01";
    const recent = thread("recent", {
      daysAgo: 5,
      subject: "Countertops",
      from: "Ben <ben@remodel.example>",
    });
    const tooOld = thread("too-old", {
      daysAgo: 200,
      subject: "Cabinets",
      from: "Ben <ben@remodel.example>",
    });
    const otherSender = thread("other", {
      daysAgo: 5,
      subject: "Cabinets",
      from: "Weeknight Recipes <hi@recipes.example>",
    });
    expect(
      ids(
        rankWithWidened(
          [],
          [],
          withSimilarity(fromBen, { recent: 0.6, "too-old": 0.9, other: 0.9 }),
          [recent, tooOld, otherSender],
        ),
      ),
    ).toEqual(["recent"]);
  });
});

describe("searchedWords", () => {
  it("is the words Cue's searches look for, without their people, dates or conditions", () => {
    expect(
      searchedWords([
        "from:carlos (vol OR flight) (Lisbonne OR Lisbon) after:2026/07/01 has:attachment",
        'FLIGHT "boarding pass" label:travel',
      ]),
    ).toBe("vol flight Lisbonne Lisbon boarding pass");
  });

  it("is empty when the searches name no words", () => {
    expect(searchedWords(["from:diane after:2026/01/01", "is:starred"])).toBe(
      "",
    );
  });
});

function rank(search: string, threads: ReturnType<typeof thread>[]) {
  return ids(rankCueFoundThreads(threads, context(search)));
}

function context(search: string) {
  return {
    searches: [search],
    labels: [NEWSLETTER_LABEL],
    now: NOW,
    timeZone: "UTC",
    provider: "google" as const,
  };
}

function withSimilarity(search: string, similarity: Record<string, number>) {
  return {
    ...context(search),
    similarity: new Map(Object.entries(similarity)),
  };
}

function ids(threads: { id: string }[]) {
  return threads.map((row) => row.id);
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
