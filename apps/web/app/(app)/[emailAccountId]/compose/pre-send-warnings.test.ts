// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_PHRASES,
  getComposeBodyText,
  getPreSendWarnings,
  LARGE_REPLY_RECIPIENT_COUNT,
  mentionsAttachment,
  type PreSendContext,
  type PreSendDraft,
} from "./pre-send-warnings";

const OWN = "me@example.com";

const reply: PreSendContext = {
  kind: "reply",
  threadAddresses: ["Alex <alex@example.com>", "sam@example.com", OWN],
  ownEmails: [OWN],
};

const draft = (overrides: Partial<PreSendDraft> = {}): PreSendDraft => ({
  to: "Alex <alex@example.com>",
  cc: "sam@example.com",
  subject: "Re: Lunch",
  bodyText: "Sounds good, see you at noon.",
  attachmentCount: 0,
  ...overrides,
});

const ids = (draftValue: PreSendDraft, context: PreSendContext = reply) =>
  getPreSendWarnings(draftValue, context).map((warning) => warning.id);

describe("getPreSendWarnings", () => {
  it("flags nothing on an ordinary reply to the thread", () => {
    expect(ids(draft())).toEqual([]);
  });

  it("flags nothing on an ordinary new message", () => {
    expect(
      ids(draft({ to: "kim@example.com", subject: "Hello" }), {
        kind: "new",
        threadAddresses: [],
        ownEmails: [OWN],
      }),
    ).toEqual([]);
  });

  describe("large reply", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => `p${i}@example.com`).join(",");
    const known = (count: number) => ({
      ...reply,
      threadAddresses: many(count).split(","),
    });

    it("warns when a reply goes to many people", () => {
      const warnings = getPreSendWarnings(
        draft({ to: many(LARGE_REPLY_RECIPIENT_COUNT), cc: "" }),
        known(LARGE_REPLY_RECIPIENT_COUNT),
      );
      expect(warnings.map((warning) => warning.id)).toEqual(["large-reply"]);
      expect(warnings[0].message).toBe(
        `This reply goes to ${LARGE_REPLY_RECIPIENT_COUNT} people.`,
      );
    });

    it("counts each person once, across To, Cc and Bcc, without the sender", () => {
      const nine = many(LARGE_REPLY_RECIPIENT_COUNT - 1);
      expect(
        ids(
          draft({ to: nine, cc: `${nine},${OWN}`, bcc: "P0@example.com" }),
          known(LARGE_REPLY_RECIPIENT_COUNT),
        ),
      ).toEqual([]);
    });

    it("leaves a large new message alone", () => {
      expect(
        ids(draft({ to: many(20), subject: "Party" }), {
          kind: "new",
          threadAddresses: [],
          ownEmails: [OWN],
        }),
      ).toEqual([]);
    });
  });

  describe("new recipients", () => {
    it("notes an address that isn't on the thread", () => {
      const warnings = getPreSendWarnings(
        draft({ cc: "sam@example.com, Jo <jo@example.com>" }),
        reply,
      );
      expect(warnings).toEqual([
        {
          id: "new-recipients",
          message: "jo@example.com isn't on this thread yet.",
          fix: "recipients",
        },
      ]);
    });

    it("summarises several new addresses", () => {
      const [warning] = getPreSendWarnings(
        draft({ bcc: "jo@example.com, kim@example.com, lee@example.com" }),
        reply,
      );
      expect(warning.message).toBe(
        "jo@example.com and 2 others aren't on this thread yet.",
      );
    });

    it("matches thread addresses regardless of case or display name", () => {
      expect(
        ids(draft({ to: "ALEX@Example.com", cc: "Sam <sam@example.com>" })),
      ).toEqual([]);
    });

    it("leaves forwards alone, which always go to someone new", () => {
      expect(
        ids(draft({ to: "kim@example.com", subject: "Fwd: Lunch" }), {
          ...reply,
          kind: "forward",
        }),
      ).toEqual([]);
    });
  });

  describe("subject", () => {
    const newMessage: PreSendContext = {
      kind: "new",
      threadAddresses: [],
      ownEmails: [OWN],
    };

    it("warns when a new message has no subject", () => {
      expect(ids(draft({ subject: "  " }), newMessage)).toEqual(["no-subject"]);
    });

    it("leaves a reply's subject alone", () => {
      expect(ids(draft({ subject: "" }))).toEqual([]);
    });
  });

  describe("attachment", () => {
    it("warns when the message mentions an attachment and has none", () => {
      expect(ids(draft({ bodyText: "The contract is attached." }))).toEqual([
        "missing-attachment",
      ]);
    });

    it("is satisfied by any attached file", () => {
      expect(
        ids(
          draft({ bodyText: "The contract is attached.", attachmentCount: 1 }),
        ),
      ).toEqual([]);
    });
  });

  it("warns about raw HTML codes in the text", () => {
    const [warning] = getPreSendWarnings(
      draft({ bodyText: "I&#x27;m in &amp; ready" }),
      reply,
    );
    expect(warning).toEqual({
      id: "escaped-markup",
      message: "The message shows raw HTML code: &#, &amp;.",
      fix: "body",
    });
  });

  it("lists every slip, the missing file first", () => {
    expect(
      ids(
        draft({
          to: "kim@example.com",
          subject: "",
          bodyText: "Q3 &amp; Q4 enclosed",
        }),
        { kind: "new", threadAddresses: [], ownEmails: [OWN] },
      ),
    ).toEqual(["missing-attachment", "no-subject", "escaped-markup"]);
  });
});

describe("mentionsAttachment", () => {
  it.each(ATTACHMENT_PHRASES)("recognises %s", (phrase) => {
    expect(
      mentionsAttachment(`Hi, ${phrase.toUpperCase()} you'll find it.`),
    ).toBe(true);
  });

  it.each([
    "Siehe Anbei: der Bericht",
    "Veuillez trouver ci-joint le devis",
    "Te envío el informe adjunto",
    "Segue o relatório em anexo",
    "Trovi il file in allegato",
  ])("recognises %s", (text) => {
    expect(mentionsAttachment(text)).toBe(true);
  });

  it.each([
    "Thanks for the update, see you soon.",
    // Part of a longer word, not the word itself.
    "The unattached garage is for sale.",
    "Our detachment arrives Monday.",
    "Hanbei is a name.",
    "",
  ])("ignores %s", (text) => {
    expect(mentionsAttachment(text)).toBe(false);
  });
});

describe("getComposeBodyText", () => {
  it("keeps what the user wrote and drops the quoted or forwarded message", () => {
    const html = `<p>Looks good to me</p><div class="gmail_quote">See the attached file</div><blockquote>Report attached</blockquote>`;
    expect(getComposeBodyText(html)).toBe("Looks good to me");
  });

  it("decodes markup but shows an escaped entity as the user sees it", () => {
    expect(getComposeBodyText("<p>Q3 &amp; Q4, I&amp;#x27;m in</p>")).toBe(
      "Q3 & Q4, I&#x27;m in",
    );
  });
});
