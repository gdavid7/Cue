// @vitest-environment jsdom
import { prepareEmailDraft } from "@inboxzero/email-editor/core";
import { describe, expect, it } from "vitest";
import { forwardEmailHtml } from "@/utils/gmail/forward";
import type { ParsedMessage } from "@/utils/types";
import {
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
  repliedToAddresses: ["Alex <alex@example.com>", "sam@example.com", OWN],
  ownEmails: [OWN],
};

const draft = (overrides: Partial<PreSendDraft> = {}): PreSendDraft => {
  const bodyText = overrides.bodyText ?? "Sounds good, see you at noon.";
  return {
    to: "Alex <alex@example.com>",
    cc: "sam@example.com",
    subject: "Re: Lunch",
    bodyText,
    placeholderText: bodyText,
    attachmentCount: 0,
    ...overrides,
  };
};

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
        repliedToAddresses: [],
        ownEmails: [OWN],
      }),
    ).toEqual([]);
  });

  describe("large reply", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) => `p${i}@example.com`).join(",");
    const known = (count: number) => ({
      ...reply,
      repliedToAddresses: many(count).split(","),
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
          repliedToAddresses: [],
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
          message: "jo@example.com wasn't on the message you're replying to.",
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
        "jo@example.com and 2 others weren't on the message you're replying to.",
      );
    });

    it("trusts recipients the user set up, such as a rule's own", () => {
      const ruleReply = {
        ...reply,
        chosenAddresses: ["Finance <finance@partner.example>"],
      };
      expect(
        ids(draft({ to: "finance@partner.example", cc: "" }), ruleReply),
      ).toEqual([]);
      const [warning] = getPreSendWarnings(
        draft({ to: "finance@partner.example", cc: "jo@example.com" }),
        ruleReply,
      );
      expect(warning.message).toBe(
        "jo@example.com wasn't on the message you're replying to.",
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
      repliedToAddresses: [],
      ownEmails: [OWN],
    };

    it("warns when a new message has no subject", () => {
      expect(ids(draft({ subject: "  " }), newMessage)).toEqual(["no-subject"]);
    });

    it("leaves a reply's subject alone", () => {
      expect(ids(draft({ subject: "" }))).toEqual([]);
    });
  });

  describe("placeholders", () => {
    it("lists up to three placeholders and counts the rest", () => {
      const warnings = getPreSendWarnings(
        draft({
          bodyText: "Hi {name}, welcome to [Company] on <insert date>.",
        }),
        reply,
      );
      expect(warnings).toEqual([
        {
          id: "placeholders",
          message:
            "The message still has placeholders to fill in: {name}, [Company], <insert date>.",
          fix: "body",
          selectText: "{name}",
        },
      ]);
      const many = getPreSendWarnings(
        draft({ bodyText: "{name} [Company] TBD XXX" }),
        reply,
      );
      expect(many[0]?.message).toBe(
        "The message still has placeholders to fill in: {name}, [Company], TBD and 1 more.",
      );
    });

    it("names a single placeholder", () => {
      const [warning] = getPreSendWarnings(
        draft({ bodyText: "Hi [Name]," }),
        reply,
      );
      expect(warning?.message).toBe(
        "The message still has a placeholder to fill in: [Name].",
      );
    });

    it("flags nothing in ordinary text", () => {
      expect(ids(draft({ bodyText: "See [1] at https://x.com/{id}" }))).toEqual(
        [],
      );
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
        { kind: "new", repliedToAddresses: [], ownEmails: [OWN] },
      ),
    ).toEqual(["missing-attachment", "no-subject", "escaped-markup"]);
  });
});

describe("mentionsAttachment", () => {
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
  it("can leave out code, which may hold a placeholder on purpose", () => {
    const html = "<p>Use <code>{name}</code> here</p><pre>[Company]</pre>";
    expect(getComposeBodyText(html, { forPlaceholders: true })).toBe(
      "Use  here",
    );
    expect(getComposeBodyText(html)).toContain("{name}");
  });

  it("can leave out link text, which the placeholder check does not read", () => {
    const html = '<p>Hi <a href="https://x.com">[Click Here]</a> {name}</p>';
    expect(getComposeBodyText(html, { forPlaceholders: true })).toBe(
      "Hi  {name}",
    );
  });

  it("keeps code for the other checks", () => {
    const html = "<p>Attached</p><pre>&amp;lt;p&amp;gt;</pre>";
    const bodyText = getComposeBodyText(html);
    expect(
      ids(draft({ bodyText, placeholderText: "Attached" }), reply),
    ).toContain("escaped-markup");
    expect(
      mentionsAttachment(getComposeBodyText("<code>attached</code>")),
    ).toBe(true);
  });

  it("keeps what the user wrote and drops the quoted or forwarded message", () => {
    const html = `<p>Looks good to me</p><div class="gmail_quote">See the attached file</div><blockquote>Report attached</blockquote>`;
    expect(getComposeBodyText(html)).toBe("Looks good to me");
  });

  it("keeps paragraphs and line breaks apart, so words don't run together", () => {
    const paragraphs = getComposeBodyText(
      "<p>Hi Bob</p><p>Attached is the report</p>",
    );
    expect(paragraphs).toMatch(/^Hi Bob\s+Attached is the report\s*$/);
    expect(mentionsAttachment(paragraphs)).toBe(true);

    const lines = getComposeBodyText("Hi Bob<br>Attached is the report");
    expect(lines).toMatch(/^Hi Bob\s+Attached is the report\s*$/);
    expect(mentionsAttachment(lines)).toBe(true);

    expect(
      getComposeBodyText("<div>One</div><ul><li>Two</li><li>Three</li></ul>"),
    ).toMatch(/^One\s+Two\s+Three\s*$/);
  });

  it("leaves out a forwarded message once the composer has split it off", () => {
    const html = forwardEmailHtml({
      content: "",
      message: {
        headers: {
          from: "Alex <alex@example.com>",
          to: "me@example.com",
          subject: "Report",
          date: "2026-10-01T10:00:00Z",
        },
        textHtml: "<p>The report is attached.</p>",
      } as ParsedMessage,
    });
    const { editableHtml } = prepareEmailDraft({ html });
    expect(mentionsAttachment(getComposeBodyText(editableHtml))).toBe(false);
  });

  it("decodes markup but shows an escaped entity as the user sees it", () => {
    expect(getComposeBodyText("<p>Q3 &amp; Q4, I&amp;#x27;m in</p>")).toBe(
      "Q3 & Q4, I&#x27;m in",
    );
  });
});
