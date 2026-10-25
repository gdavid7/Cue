import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { getMockMessage } from "@/__tests__/helpers";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import { createScopedLogger } from "@/utils/logger";
import type { EmailProvider } from "@/utils/email/types";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import {
  checkSuggestion,
  contextSources,
  renderSource,
  type Source,
  suggestReaderReply,
  suggestReply,
  vouchedLinkMessageIds,
  webSearchQuery,
  webSource,
} from "./suggest-reply";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
const {
  collectThreadContext,
  getEmailAccountWithAi,
  generateObject,
  getModelForUseCase,
  exa,
} = vi.hoisted(() => ({
  collectThreadContext: vi.fn(),
  getEmailAccountWithAi: vi.fn(),
  generateObject: vi.fn(),
  getModelForUseCase: vi.fn(() => ({})),
  exa: { enabled: true, search: vi.fn() },
}));
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));
vi.mock("@/utils/llms", () => ({
  createGenerateObject: () => generateObject,
}));
vi.mock("@/utils/llms/use-cases", () => ({
  getModelForUseCase,
  LlmUseCase: { DraftReply: "draft-reply", PredraftReply: "predraft-reply" },
}));
vi.mock("@/utils/premium/limits", () => ({
  assertHasAiAccess: async () => {},
}));
vi.mock("@/utils/ai/reply/reply-memory", () => ({
  getReplyMemoriesForPrompt: async () => ({ selectedMemories: [] }),
}));
vi.mock("@/utils/exa/search", () => ({
  isExaSearchEnabled: () => exa.enabled,
  searchExa: exa.search,
}));
vi.mock(
  "@/utils/thread-context/get-thread-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/utils/thread-context/get-thread-context")
    >()),
    collectThreadContext,
  }),
);
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

  it("suggests nothing while they are off", async () => {
    const latest = getMockMessage({
      id: "m1",
      threadId: "t1",
      from: "sarah@example.com",
    });
    collectThreadContext.mockResolvedValue({
      thread: { id: "t1", messages: [latest], snippet: "" },
      items: [],
    });
    prisma.emailAccount.findUnique.mockResolvedValue({
      webLookupEnabled: true,
      rules: [{ enabled: false, actions: [{ type: ActionType.LABEL }] }],
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

  // DR-5: mailboxes from before drafting was the default never chose, which
  // counts as on.
  it("answers a mailbox that never chose", async () => {
    const latest = getMockMessage({
      id: "m4",
      threadId: "t4",
      from: "sarah@example.com",
    });
    collectThreadContext.mockResolvedValue({
      thread: { id: "t4", messages: [latest], snippet: "" },
      items: [],
    });
    getEmailAccountWithAi.mockResolvedValue({
      id: "a1",
      userId: "u1",
      email: "me@example.com",
      name: "Me",
      timezone: null,
      user: { aiApiKey: null },
    });
    generateObject.mockResolvedValue({
      object: {
        enoughEvidence: false,
        missing: "Which Friday.",
        webQuery: "",
        reply: "",
        claims: [],
      },
    });
    prisma.emailAccount.findUnique.mockResolvedValue({
      webLookupEnabled: true,
      rules: [{ enabled: true, actions: [{ type: ActionType.LABEL }] }],
    } as never);

    const result = await suggestReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t4",
      emailProvider: {} as EmailProvider,
      logger,
    });

    expect(result).toMatchObject({ status: "insufficient" });
    expect(getEmailAccountWithAi).toHaveBeenCalled();
  });

  // Written unasked for incoming mail, so it runs on the cheap tier.
  it("writes a pre-draft on its own model tier", async () => {
    const latest = getMockMessage({
      id: "m5",
      threadId: "t5",
      from: "sarah@example.com",
    });
    collectThreadContext.mockResolvedValue({
      thread: { id: "t5", messages: [latest], snippet: "" },
      items: [],
    });
    getEmailAccountWithAi.mockResolvedValue({
      id: "a1",
      userId: "u1",
      email: "me@example.com",
      name: "Me",
      timezone: null,
      user: { aiApiKey: null },
    });
    generateObject.mockResolvedValue({
      object: {
        enoughEvidence: false,
        missing: "Which Friday.",
        webQuery: "",
        reply: "",
        claims: [],
      },
    });
    getModelForUseCase.mockClear();

    await suggestReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t5",
      emailProvider: {} as EmailProvider,
      logger,
      settings: { draftReplies: "on", webLookupEnabled: false },
      source: "predraft",
    });

    expect(getModelForUseCase).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "predraft-reply",
    );
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

describe("suggestReply and the server cache", () => {
  const logger = createScopedLogger("suggest-reply-test");
  const abstain = {
    enoughEvidence: false,
    missing: "The venue's opening hours.",
    webQuery: "venue opening hours",
    reply: "",
    claims: [],
  };

  beforeEach(() => {
    recordingRedis.reset();
    generateObject.mockReset();
    exa.search.mockReset();
    exa.enabled = true;
    const latest = getMockMessage({
      id: "m3",
      threadId: "t3",
      from: "sarah@example.com",
      textPlain: "When does the venue open on Friday?",
    });
    collectThreadContext.mockResolvedValue({
      thread: { id: "t3", messages: [latest], snippet: "" },
      items: [],
    });
    getEmailAccountWithAi.mockResolvedValue({
      id: "a1",
      userId: "u1",
      email: "me@example.com",
      name: "Me",
      timezone: null,
      user: { aiApiKey: null },
    });
  });

  function settings({ webLookupEnabled = true } = {}) {
    prisma.emailAccount.findUnique.mockResolvedValue({
      webLookupEnabled,
      rules: [{ enabled: true, actions: [{ type: ActionType.DRAFT_EMAIL }] }],
    } as never);
  }

  function suggest(options: { searchWeb?: boolean; webQuery?: string } = {}) {
    return suggestReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t3",
      emailProvider: {} as EmailProvider,
      logger,
      ...options,
    });
  }

  // RD-3: a suggestion quotes the user's mail, so the browser keeps it.
  it("works a suggestion out without keeping it on the server", async () => {
    settings();
    generateObject.mockResolvedValue({ object: abstain });

    await expect(suggest()).resolves.toMatchObject({
      status: "insufficient",
      webQuery: "venue opening hours",
    });
    expect(recordingRedis.everythingWritten()).not.toContain("venue");
  });

  it("runs only the web pass when the browser kept the abstention's query", async () => {
    settings();
    exa.search.mockResolvedValue([
      {
        title: "Venue hours",
        url: "https://venue.example/hours",
        text: "Open from 9 AM on Fridays.",
      },
    ]);
    generateObject.mockResolvedValue({
      object: {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "It opens at 9 AM on Friday.",
        claims: [
          { fact: "Opens at 9", sourceId: "c1", quote: "Open from 9 AM" },
        ],
      },
    });

    await expect(
      suggest({ searchWeb: true, webQuery: "venue opening hours" }),
    ).resolves.toMatchObject({ status: "suggested" });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(exa.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "venue opening hours" }),
    );
  });

  it("answers from mail and calendar only while web lookup is off", async () => {
    settings({ webLookupEnabled: false });
    generateObject.mockResolvedValue({ object: abstain });

    await expect(
      suggest({ searchWeb: true, webQuery: "venue opening hours" }),
    ).resolves.toMatchObject({ status: "insufficient" });
    expect(exa.search).not.toHaveBeenCalled();
  });
});

// DR-5: one line per reader suggestion says how it ended, by ID and fixed
// reason only, so "never seen" can be told apart from "Cue chose not to".
describe("suggestReaderReply outcome log", () => {
  const logger = createScopedLogger("suggest-reply-test");
  const subject = "Venue booking for the Acme offsite";
  const sender = "sarah.chen@example.com";
  const on = { draftReplies: "on" as const, webLookupEnabled: false };
  const LOG_FIELDS = ["outcome", "reason", "threadId", "webPass"];

  beforeEach(() => {
    generateObject.mockReset();
    collectThreadContext.mockReset();
    collectThreadContext.mockResolvedValue({
      thread: {
        id: "t5",
        messages: [
          getMockMessage({
            id: "m5",
            threadId: "t5",
            from: sender,
            subject,
            textPlain: "When does the venue open on Friday?",
          }),
        ],
        snippet: "",
      },
      items: [],
    });
    getEmailAccountWithAi.mockResolvedValue({
      id: "a1",
      userId: "u1",
      email: "me@example.com",
      name: "Me",
      timezone: null,
      user: { aiApiKey: null },
    });
  });

  async function outcomeOf(
    settings: Parameters<typeof suggestReaderReply>[0]["settings"] = on,
  ) {
    const info = vi.spyOn(logger, "info");
    await suggestReaderReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t5",
      emailProvider: {} as EmailProvider,
      logger,
      settings,
    }).catch(() => undefined);
    const calls = info.mock.calls.filter(
      ([message]) => message === "Reply suggestion outcome",
    );
    info.mockRestore();
    expect(calls).toHaveLength(1);
    const fields = calls[0]![1] as Record<string, unknown>;
    // IDs and fixed values only: nothing from the mail or the reply.
    for (const key of Object.keys(fields)) expect(LOG_FIELDS).toContain(key);
    const logged = JSON.stringify(fields);
    for (const text of [subject, sender, "venue", "9 AM", "opening hours"]) {
      expect(logged).not.toContain(text);
    }
    return fields;
  }

  it("logs a suggestion", async () => {
    generateObject.mockResolvedValue({
      object: {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "The venue opens at 9 AM on Friday.",
        claims: [],
      },
    });

    expect(await outcomeOf()).toEqual({
      outcome: "suggested",
      threadId: "t5",
      webPass: false,
    });
  });

  it("logs the model abstaining as declined", async () => {
    generateObject.mockResolvedValue({
      object: {
        enoughEvidence: false,
        missing: "The venue's opening hours.",
        webQuery: "venue opening hours",
        reply: "",
        claims: [],
      },
    });

    expect(await outcomeOf()).toMatchObject({
      outcome: "declined",
      reason: "insufficient-evidence",
    });
  });

  it("logs drafting turned off as gated", async () => {
    expect(
      await outcomeOf({ draftReplies: "off", webLookupEnabled: false }),
    ).toMatchObject({ outcome: "gated", reason: "drafting-off" });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("logs a thread the user answered last as gated", async () => {
    collectThreadContext.mockResolvedValue({
      thread: {
        id: "t5",
        messages: [getMockMessage({ id: "m6", from: "me@example.com" })],
        snippet: "",
      },
      items: [],
    });

    expect(await outcomeOf()).toMatchObject({
      outcome: "gated",
      reason: "already-replied",
    });
  });

  it("logs a Gmail quota deferral as unavailable and still fails", async () => {
    collectThreadContext.mockRejectedValue(
      new GmailCallDeferredError(5000, "interactive"),
    );

    expect(await outcomeOf()).toMatchObject({
      outcome: "unavailable",
      reason: "quota",
    });
  });

  it("logs a model failure as unavailable", async () => {
    generateObject.mockRejectedValue(new Error("model overloaded"));

    expect(await outcomeOf()).toMatchObject({
      outcome: "unavailable",
      reason: "error",
    });
  });
});

describe("suggestReply attachments in the model's sources", () => {
  const logger = createScopedLogger("suggest-reply-test");
  const attachment = (filename: string) => ({
    attachmentId: filename,
    filename,
    mimeType: "application/pdf",
    size: 1000,
    headers: {},
  });

  async function promptFor(messages: ReturnType<typeof getMockMessage>[]) {
    collectThreadContext.mockResolvedValue({
      thread: { id: "t9", messages, snippet: "" },
      items: [],
    });
    getEmailAccountWithAi.mockResolvedValue({
      id: "a1",
      userId: "u1",
      email: "me@example.com",
      name: "Me",
      timezone: null,
      user: { aiApiKey: null },
    });
    generateObject.mockClear();
    generateObject.mockResolvedValue({
      object: {
        enoughEvidence: false,
        missing: "Nothing.",
        webQuery: "",
        reply: "",
        claims: [],
      },
    });
    await suggestReply({
      emailAccountId: "a1",
      userEmail: "me@example.com",
      threadId: "t9",
      emailProvider: {} as EmailProvider,
      logger,
      settings: { draftReplies: "on", webLookupEnabled: false },
    });
    return generateObject.mock.calls[0][0].prompt as string;
  }

  it("names a message's attachments, a capped number of capped names", async () => {
    const prompt = await promptFor([
      getMockMessage({
        id: "m1",
        threadId: "t9",
        from: "sarah@example.com",
        textPlain: "Here you go.",
        attachments: [
          attachment("contract.pdf"),
          attachment("w9.pdf"),
          attachment(`${"a".repeat(200)}.pdf`),
          attachment("four.pdf"),
          attachment("five.pdf"),
          attachment("six.pdf"),
        ],
      }),
    ]);

    const line = prompt.split("\n").find((l) => l.startsWith("Attachments:"));
    expect(line).toBe(
      `Attachments: contract.pdf, w9.pdf, ${"a".repeat(80)}, four.pdf, five.pdf`,
    );
  });

  it("leaves the line out for a message without attachments", async () => {
    const prompt = await promptFor([
      getMockMessage({ id: "m1", threadId: "t9", from: "sarah@example.com" }),
    ]);

    expect(prompt).not.toContain("Attachments:");
  });
});
