import { describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { getMockMessage } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";
import type { EmailProvider } from "@/utils/email/types";
import {
  checkSuggestion,
  getCachedSuggestedReply,
  renderSource,
  type Source,
  suggestReply,
  webSearchQuery,
  webSource,
} from "./suggest-reply";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
const { cache, collectThreadContext, getEmailAccountWithAi } = vi.hoisted(
  () => ({
    cache: new Map<string, unknown>(),
    collectThreadContext: vi.fn(),
    getEmailAccountWithAi: vi.fn(),
  }),
);
vi.mock("@/utils/redis", () => ({
  redis: { get: async (key: string) => cache.get(key) ?? null },
}));
vi.mock("@/utils/thread-context/get-thread-context", () => ({
  collectThreadContext,
}));
vi.mock("@/utils/user/get", () => ({ getEmailAccountWithAi }));

const SOURCES: Source[] = [
  {
    id: "m1",
    kind: "message",
    title: "Sarah Chen",
    text: "From: Sarah Chen\n\nCan you confirm the renewal price before Friday?",
  },
  {
    id: "c1",
    kind: "email",
    title: "Acme pricing",
    text: "From: Nora Patel\n\nWe agreed on   $48,000 per year\nfor the Acme renewal & support.",
    threadId: "pricing-thread",
  },
];

describe("checkSuggestion", () => {
  it("suggests the reply when every quote is in the source it cites", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "Hi Sarah, the renewal is $48,000 per year.",
        claims: [
          {
            fact: "The renewal is $48,000 per year",
            sourceId: "c1",
            // Line breaks, spacing, case, curly quotes and an ellipsis differ.
            quote:
              "“…we agreed on $48,000 per year for the Acme renewal &amp; support",
          },
        ],
      },
      SOURCES,
    );

    expect(result).toMatchObject({
      status: "suggested",
      citations: [
        {
          fact: "The renewal is $48,000 per year",
          source: {
            id: "c1",
            title: "Acme pricing",
            threadId: "pricing-thread",
          },
        },
      ],
    });
  });

  it("withholds the reply when a quote isn't in its source", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "Hi Sarah, the renewal is $45,000.",
        claims: [
          {
            fact: "The renewal is $45,000",
            sourceId: "c1",
            quote: "We agreed on $45,000 per year",
          },
        ],
      },
      SOURCES,
    );

    expect(result).toEqual({
      status: "insufficient",
      missing: "",
      unsupported: ["The renewal is $45,000"],
      webQuery: "",
    });
  });

  it("withholds the reply when it cites a source it wasn't given", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "See you Thursday.",
        claims: [
          { fact: "The call is Thursday", sourceId: "c9", quote: "Thursday" },
        ],
      },
      SOURCES,
    );

    expect(result.status).toBe("insufficient");
  });

  it("passes on what's missing when the model abstains", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: false,
        missing: "The agreed renewal price.",
        webQuery: "",
        reply: "",
        claims: [],
      },
      SOURCES,
    );

    expect(result).toEqual({
      status: "insufficient",
      missing: "The agreed renewal price.",
      unsupported: [],
      webQuery: "",
    });
  });
});

describe("web sources", () => {
  const page = webSource({
    id: "c3",
    title: "Airlines at SFO",
    url: "https://www.flysfo.com/flights/airlines",
    text: "United Airlines operates from Terminal 3 at SFO.",
  });

  it("render as a web page with its title and domain, like the other kinds", () => {
    expect(renderSource(page)).toBe(
      `<source id="c3" kind="web">
Web page: Airlines at SFO (flysfo.com)
United Airlines operates from Terminal 3 at SFO.
</source>`,
    );
  });

  it("back a reply only with words the page contains", () => {
    const claim = (quote: string) =>
      checkSuggestion(
        {
          enoughEvidence: true,
          missing: "",
          reply: "I land at Terminal 3.",
          claims: [{ fact: "United uses Terminal 3", sourceId: "c3", quote }],
        },
        [...SOURCES, page],
      );

    expect(
      claim("United Airlines operates from Terminal 3 at SFO"),
    ).toMatchObject({
      status: "suggested",
      citations: [
        {
          source: {
            kind: "web",
            url: "https://www.flysfo.com/flights/airlines",
          },
        },
      ],
    });
    expect(claim("United Airlines operates from Terminal 2").status).toBe(
      "insufficient",
    );
  });
});

describe("webSearchQuery", () => {
  // The query leaves Cue for a web search API, so it carries only the public
  // words the model chose: never the subject or what the mail says is missing.
  it("searches for the model's public query and nothing else", () => {
    const abstention = checkSuggestion(
      {
        enoughEvidence: false,
        missing: "Which SFO terminal your United flight lands at.",
        webQuery: "  SFO United   domestic arrivals terminal ",
        reply: "",
        claims: [],
      },
      SOURCES,
    );
    if (abstention.status !== "insufficient")
      throw new Error("expected abstention");
    expect(webSearchQuery(abstention)).toBe(
      "SFO United domestic arrivals terminal",
    );
  });

  it("skips the web when nothing public would settle it", () => {
    expect(webSearchQuery({ webQuery: "  " })).toBe("");
  });
});

describe("getCachedSuggestedReply", () => {
  const key = { emailAccountId: "a1", threadId: "t1", messageId: "m1" };
  const enabled = { draftRepliesEnabled: true, webLookupEnabled: true };

  // The reader shows the web pass's answer when there was one, so the
  // inbox row must agree with it.
  it("prefers the answer from the web pass", async () => {
    cache.clear();
    cache.set("suggested-reply:v2:a1:t1:m1", {
      status: "insufficient",
      missing: "Flight time",
      unsupported: [],
      webQuery: "",
    });
    cache.set("suggested-reply-web:v2:a1:t1:m1", {
      status: "suggested",
      reply: "Landing at 6:35 PM.",
      citations: [],
    });

    expect(await getCachedSuggestedReply(key, enabled)).toMatchObject({
      status: "suggested",
    });
  });

  // The route serves cached replies without running suggestReply, so the
  // same settings must hold here.
  it("returns nothing while auto draft replies are off", async () => {
    cache.clear();
    cache.set("suggested-reply:v2:a1:t1:m1", {
      status: "suggested",
      reply: "Yes.",
      citations: [],
    });

    expect(
      await getCachedSuggestedReply(key, {
        ...enabled,
        draftRepliesEnabled: false,
      }),
    ).toEqual({ status: "unavailable" });
  });

  it("ignores the web pass's answer while web lookup is off", async () => {
    cache.clear();
    cache.set("suggested-reply:v2:a1:t1:m1", {
      status: "insufficient",
      missing: "Flight time",
      unsupported: [],
      webQuery: "",
    });
    cache.set("suggested-reply-web:v2:a1:t1:m1", {
      status: "suggested",
      reply: "Landing at 6:35 PM.",
      citations: [],
    });

    expect(
      await getCachedSuggestedReply(key, {
        ...enabled,
        webLookupEnabled: false,
      }),
    ).toMatchObject({ status: "insufficient" });
  });

  it("falls back to the first answer, and to nothing for a new message", async () => {
    cache.clear();
    cache.set("suggested-reply:v2:a1:t1:m1", {
      status: "suggested",
      reply: "Yes.",
      citations: [],
    });

    expect(await getCachedSuggestedReply(key, enabled)).toMatchObject({
      status: "suggested",
    });
    expect(
      await getCachedSuggestedReply({ ...key, messageId: "m2" }, enabled),
    ).toBeNull();
  });
});

describe("suggestReply when auto draft replies are off", () => {
  const logger = createScopedLogger("suggest-reply-test");

  it("suggests nothing, even when a suggestion is cached", async () => {
    const latest = getMockMessage({
      id: "m1",
      threadId: "t1",
      from: "sarah@example.com",
    });
    collectThreadContext.mockResolvedValue({
      thread: { id: "t1", messages: [latest], snippet: "" },
      items: [],
    });
    cache.set("suggested-reply:v2:a1:t1:m1", {
      status: "suggested",
      reply: "Sure, Friday works.",
      citations: [],
    });
    prisma.emailAccount.findUnique.mockResolvedValue({
      webLookupEnabled: true,
      rules: [{ enabled: true, actions: [{ type: ActionType.LABEL }] }],
    } as never);

    const result = await suggestReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t1",
      emailProvider: {} as EmailProvider,
      logger,
    });

    expect(result).toEqual({ status: "unavailable" });
    expect(getEmailAccountWithAi).not.toHaveBeenCalled();
  });

  it("suggests nothing when the To Reply rule is turned off", async () => {
    const latest = getMockMessage({
      id: "m2",
      threadId: "t2",
      from: "sarah@example.com",
    });
    collectThreadContext.mockResolvedValue({
      thread: { id: "t2", messages: [latest], snippet: "" },
      items: [],
    });
    prisma.emailAccount.findUnique.mockResolvedValue({
      webLookupEnabled: true,
      rules: [{ enabled: false, actions: [{ type: ActionType.DRAFT_EMAIL }] }],
    } as never);

    const result = await suggestReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t2",
      emailProvider: {} as EmailProvider,
      logger,
    });

    expect(result).toEqual({ status: "unavailable" });
  });
});

describe("suggestReply when web lookup is off", () => {
  it("answers from mail and calendar only, without searching the web", async () => {
    const latest = getMockMessage({
      id: "m3",
      threadId: "t3",
      from: "sarah@example.com",
    });
    collectThreadContext.mockResolvedValue({
      thread: { id: "t3", messages: [latest], snippet: "" },
      items: [],
    });
    const plain = {
      status: "insufficient",
      missing: "The venue's opening hours.",
      unsupported: [],
      webQuery: "venue opening hours",
    };
    cache.set("suggested-reply:v2:a1:t3:m3", plain);
    prisma.emailAccount.findUnique.mockResolvedValue({
      webLookupEnabled: false,
      rules: [{ enabled: true, actions: [{ type: ActionType.DRAFT_EMAIL }] }],
    } as never);

    const result = await suggestReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t3",
      emailProvider: {} as EmailProvider,
      logger: createScopedLogger("suggest-reply-test"),
      searchWeb: true,
    });

    expect(result).toEqual(plain);
    expect(getEmailAccountWithAi).not.toHaveBeenCalled();
  });
});
