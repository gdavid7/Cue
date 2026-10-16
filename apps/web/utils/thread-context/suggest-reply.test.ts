import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { getMockMessage } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";
import type { EmailProvider } from "@/utils/email/types";
import {
  checkSuggestion,
  contextSources,
  getCachedSuggestedReplies,
  getCachedSuggestedReply,
  renderSource,
  type Source,
  suggestReply,
  vouchedLinkMessageIds,
  webSearchQuery,
  webSource,
} from "./suggest-reply";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
const { cache, redisCalls, collectThreadContext, getEmailAccountWithAi } =
  vi.hoisted(() => ({
    cache: new Map<string, unknown>(),
    redisCalls: [] as string[],
    collectThreadContext: vi.fn(),
    getEmailAccountWithAi: vi.fn(),
  }));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: async (key: string) => {
      redisCalls.push("get");
      return cache.get(key) ?? null;
    },
    mget: async (...keys: string[]) => {
      redisCalls.push("mget");
      return keys.map((key) => cache.get(key) ?? null);
    },
  },
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

  // An inbox page asks for up to 50 rows at once; each Redis command is
  // billed, so the whole page is one read.
  it("reads a page of messages' replies in one Redis command", async () => {
    cache.clear();
    redisCalls.length = 0;
    cache.set("suggested-reply:v2:a1:t1:m1", {
      status: "suggested",
      reply: "Yes.",
      citations: [],
    });
    cache.set("suggested-reply-web:v2:a1:t2:m2", {
      status: "suggested",
      reply: "Landing at 6:35 PM.",
      citations: [],
    });

    const replies = await getCachedSuggestedReplies(
      [
        key,
        { emailAccountId: "a1", threadId: "t2", messageId: "m2" },
        { emailAccountId: "a1", threadId: "t3", messageId: "m3" },
      ],
      enabled,
    );

    expect(replies).toMatchObject([
      { status: "suggested", reply: "Yes." },
      { status: "suggested", reply: "Landing at 6:35 PM." },
      null,
    ]);
    expect(redisCalls).toEqual(["mget"]);
  });

  it("reads nothing while auto draft replies are off", async () => {
    redisCalls.length = 0;

    expect(
      await getCachedSuggestedReplies([key], {
        ...enabled,
        draftRepliesEnabled: false,
      }),
    ).toEqual([{ status: "unavailable" }]);
    expect(redisCalls).toEqual([]);
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

describe("contextSources", () => {
  const item = (
    kind: "file" | "task" | "contact",
    title: string,
    source: string,
    linkedFrom?: string,
  ) => ({
    id: `${kind}:${title}`,
    kind,
    title,
    snippet: "",
    text: `${title}\nIn Progress`,
    at: "2026-10-12T00:00:00.000Z",
    source,
    linkedFrom,
    reasons: [],
  });
  const items = [
    item("task", "OPS-12 Rotate staging keys", "Jira", "m1"),
    item("contact", "Nora Patel", "HubSpot"),
    item("file", "Milestone 2 write-up", "Google Drive", "m1"),
  ];

  function sourcesFor({
    senderAuthenticated,
    trusted,
    from = items,
  }: {
    senderAuthenticated: boolean;
    trusted: string[];
    from?: ReturnType<typeof item>[];
  }) {
    return contextSources({
      items: from,
      senderAuthenticated,
      vouchedLinkMessageIds: new Set(trusted),
      emailProvider: {} as EmailProvider,
      timezone: null,
      logger: createScopedLogger("suggest-reply-test"),
    });
  }

  it("backs a reply with linked tasks and the authenticated sender's record, labelled as such", async () => {
    const sources = await sourcesFor({
      senderAuthenticated: true,
      trusted: ["m1"],
    });

    expect(sources.map((s) => [s.id, s.kind, s.text])).toEqual([
      [
        "c1",
        "task",
        "Task: OPS-12 Rotate staging keys (Jira)\nOPS-12 Rotate staging keys\nIn Progress",
      ],
      [
        "c2",
        "contact",
        "Contact: Nora Patel (HubSpot)\nNora Patel\nIn Progress",
      ],
      [
        "c3",
        "file",
        "File: Milestone 2 write-up (Google Drive)\nMilestone 2 write-up\nIn Progress",
      ],
    ]);
  });

  // Anyone can forge From: to pull in the record of whoever they impersonate.
  it("leaves out the sender's record when the sender's address wasn't authenticated", async () => {
    const sources = await sourcesFor({
      senderAuthenticated: false,
      trusted: ["m1"],
    });

    expect(sources.map((s) => s.kind)).toEqual(["task", "file"]);
  });

  // Anyone can send a link to a guessed task id; what counts is who sent
  // the message the link is in, not who wrote last.
  it("uses a task only when the message that links to it was authenticated", async () => {
    const sources = await sourcesFor({
      senderAuthenticated: true,
      trusted: ["m2"],
      from: [
        item("task", "OPS-12 from m1", "Jira", "m1"),
        item("task", "OPS-13 from m2", "Jira", "m2"),
        item("task", "OPS-14 from nowhere", "Jira"),
      ],
    });

    expect(sources.map((s) => s.title)).toEqual(["OPS-13 from m2"]);
  });
});

describe("vouchedLinkMessageIds", () => {
  function authenticated(id: string, from: string) {
    const domain = from.split("@")[1];
    return {
      ...getMockMessage({ id, from }),
      headers: {
        ...getMockMessage({ from }).headers,
        "authentication-results": `mx.google.com; dmarc=pass header.from=${domain}`,
      },
    };
  }

  function vouched(
    userEmail: string,
    messages: ReturnType<typeof getMockMessage>[],
  ) {
    return vouchedLinkMessageIds({
      thread: { id: "t", snippet: "", messages },
      userEmail,
      emailAccountId: "a1",
    }).then((ids) => [...ids]);
  }

  beforeEach(() => {
    prisma.emailMessage.findFirst.mockReset();
    prisma.emailMessage.findFirst.mockResolvedValue(null);
  });

  it("vouches for an authenticated colleague in the user's own organization", async () => {
    expect(
      await vouched("me@acme.com", [authenticated("m1", "nora@eng.acme.com")]),
    ).toEqual(["m1"]);
    expect(prisma.emailMessage.findFirst).not.toHaveBeenCalled();
  });

  it("never counts a free-mail domain as one organization", async () => {
    expect(
      await vouched("me@gmail.com", [authenticated("m1", "nora@gmail.com")]),
    ).toEqual([]);
  });

  it.each([
    ["web.de"],
    ["qq.com"],
    ["yahoo.co.jp"],
  ])("never counts the mailbox provider %s as one organization", async (domain) => {
    expect(
      await vouched(`me@${domain}`, [authenticated("m1", `nora@${domain}`)]),
    ).toEqual([]);
  });

  // A university's domain is shared by everyone who studies or works there.
  it.each([
    ["ucsd.edu"],
    ["ox.ac.uk"],
    ["unimelb.edu.au"],
  ])("never counts the academic domain %s as one organization", async (domain) => {
    expect(
      await vouched(`me@${domain}`, [
        authenticated("m1", `someone@cs.${domain}`),
      ]),
    ).toEqual([]);
  });

  it("still vouches for a professor at the user's university whom the user has written to", async () => {
    const question = getMockMessage({
      id: "m1",
      from: "me@ucsd.edu",
      to: "Prof. Lee <lee@cs.ucsd.edu>",
      labelIds: ["SENT"],
    });

    expect(
      await vouched("me@ucsd.edu", [
        question,
        authenticated("m2", "lee@cs.ucsd.edu"),
      ]),
    ).toEqual(["m1", "m2"]);
  });

  it("asks stored mail once per sender, however many of their messages are in the thread", async () => {
    await vouched("me@acme.com", [
      authenticated("m1", "nora@northwind.com"),
      authenticated("m2", "Nora@Northwind.com"),
      authenticated("m3", "kai@other.example"),
    ]);

    expect(
      prisma.emailMessage.findFirst.mock.calls.map(
        ([args]) => (args?.where?.to as { equals: string }).equals,
      ),
    ).toEqual(["nora@northwind.com", "kai@other.example"]);
  });

  it("keeps organizations under a shared hosting suffix apart", async () => {
    expect(
      await vouched("alice@alice.github.io", [
        authenticated("m1", "bob@bob.github.io"),
      ]),
    ).toEqual([]);
  });

  it("vouches for an authenticated outsider the user wrote to earlier in the thread", async () => {
    const reply = getMockMessage({
      id: "m1",
      from: "me@acme.com",
      to: "Nora <nora@northwind.com>",
      labelIds: ["SENT"],
    });

    expect(
      await vouched("me@acme.com", [
        reply,
        authenticated("m2", "nora@northwind.com"),
      ]),
    ).toEqual(["m1", "m2"]);
    expect(prisma.emailMessage.findFirst).not.toHaveBeenCalled();
  });

  it("vouches for an authenticated outsider the user has emailed before, from stored mail", async () => {
    prisma.emailMessage.findFirst.mockResolvedValue({ id: "e1" } as never);

    expect(
      await vouched("me@acme.com", [authenticated("m1", "nora@northwind.com")]),
    ).toEqual(["m1"]);
    expect(prisma.emailMessage.findFirst).toHaveBeenCalledWith({
      where: {
        emailAccountId: "a1",
        sent: true,
        to: { equals: "nora@northwind.com", mode: "insensitive" },
      },
      select: { id: true },
    });
  });

  it("doesn't vouch for an authenticated stranger, or for anyone unauthenticated", async () => {
    expect(
      await vouched("me@acme.com", [
        authenticated("m1", "mallory@evil.example"),
        // Claims to be a colleague, but Gmail didn't authenticate it.
        getMockMessage({ id: "m2", from: "nora@acme.com" }),
        // Claims to be the user, who didn't send it.
        getMockMessage({ id: "m3", from: "me@acme.com" }),
      ]),
    ).toEqual([]);
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
