// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CueStrip } from "@/app/(app)/[emailAccountId]/mail/CueStrip";
import type { ThreadMessage } from "@/components/email-list/types";
import type { EmailLabels } from "@/providers/email-label-types";

const mocks = vi.hoisted(() => ({
  requests: [] as { url: string; emailAccountId: string | undefined }[],
  plans: [] as { status: string; rule: { systemType: string } }[],
  insight: null as { action: "reply" | "do" | "none" } | null,
  insightFailures: 0,
  aiAccess: true,
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/hooks/usePremium", () => ({
  usePremium: () => ({ hasAiAccess: mocks.aiAccess, isLoading: false }),
}));
vi.mock("@/utils/actions/calendar", () => ({ addToCalendarAction: vi.fn() }));
vi.mock("@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender", () => ({
  useUnsubscribeSender: () => ({
    isUnsubscribeDisabled: false,
    onUnsubscribe: vi.fn(),
    PremiumModal: () => null,
  }),
}));

const THREAD_ACCOUNT = "account-2";
const SUMMARY =
  "Recruiter asks whether your graduation date is changing or you're going to grad school.";
const LABELS: EmailLabels = {
  Label_reply: { id: "Label_reply", name: "To Reply" },
  Label_news: { id: "Label_news", name: "Newsletter" },
};

describe("CueStrip", () => {
  beforeEach(() => {
    mocks.requests = [];
    mocks.plans = [];
    mocks.insight = null;
    mocks.insightFailures = 0;
    mocks.aiAccess = true;
  });
  afterEach(cleanup);

  it("sums up a conversation with a person in a labelled region", async () => {
    renderStrip({ labels: ["Label_reply"] });

    const strip = await screen.findByRole("region", { name: "Cue summary" });
    expect(await within(strip).findByText(SUMMARY)).toBeTruthy();
  });

  it("stays hidden for a newsletter and never asks for a summary", async () => {
    renderStrip({ labels: ["Label_news"] });

    await waitForRequest("/api/user/thread-plans");
    expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull();
    expect(requested("/api/user/thread-brief")).toBe(false);
  });

  // Keyboard movement through the list: the space is held, nothing is asked.
  it("holds its space but asks for nothing until the conversation is actually open", async () => {
    renderStrip({ labels: ["Label_reply"], enabled: false });

    await flush();
    expect(screen.getByRole("region", { name: "Cue summary" })).toBeTruthy();
    expect(mocks.requests).toEqual([]);
  });

  // The space is there before Cue knows, so the messages never move down;
  // mail that turns out to ask nothing folds it away.
  it("holds the space while Cue decides, then folds it away for mail that asks nothing", async () => {
    mocks.insight = { action: "none" };
    renderStrip({ labels: [] });

    expect(screen.getByRole("region", { name: "Cue summary" })).toBeTruthy();
    await waitForRequest("/api/user/inbox-insights");
    await vi.waitFor(() =>
      expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull(),
    );
    expect(requested("/api/user/thread-brief")).toBe(false);
  });

  it("shows for uncategorised mail when Cue's note says it needs the user", async () => {
    mocks.insight = { action: "reply" };
    renderStrip({ labels: [] });

    expect(await screen.findByText(SUMMARY)).toBeTruthy();
  });

  // A failed lookup isn't an answer: folding and then reopening when a retry
  // lands would move the messages twice.
  it("keeps holding the space while Cue's note fails to load, then shows", async () => {
    mocks.insight = { action: "reply" };
    mocks.insightFailures = 1;
    renderStrip({ labels: [] }, { errorRetryInterval: 10 });

    await waitForRequest("/api/user/inbox-insights");
    expect(screen.getByRole("region", { name: "Cue summary" })).toBeTruthy();
    expect(await screen.findByText(SUMMARY)).toBeTruthy();
  });

  it("folds away if Cue can't decide in time, and stays folded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.insight = { action: "reply" };
      mocks.insightFailures = 1000;
      renderStrip({ labels: [] }, { errorRetryInterval: 60_000 });
      expect(screen.getByRole("region", { name: "Cue summary" })).toBeTruthy();

      await act(() => vi.advanceTimersByTimeAsync(11_000));
      expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull();

      mocks.insightFailures = 0;
      await act(() => vi.advanceTimersByTimeAsync(180_000));
      expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Without AI, Cue has no note to decide by, so only a category shows it.
  it("holds no space for uncategorised mail when the account has no AI", async () => {
    mocks.aiAccess = false;
    renderStrip({ labels: [] });

    expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull();
    await flush();
    expect(requested("/api/user/inbox-insights")).toBe(false);
  });

  it("still summarises a labelled conversation without AI", async () => {
    mocks.aiAccess = false;
    renderStrip({ labels: ["Label_reply"] });

    expect(await screen.findByText(SUMMARY)).toBeTruthy();
  });

  // Busy means a summary is on its way, not that Cue is still deciding.
  it("is busy only while its summary loads", async () => {
    mocks.insight = { action: "none" };
    const { container } = renderStripWithContainer({ labels: [] });

    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    await waitForRequest("/api/user/inbox-insights");
    await vi.waitFor(() =>
      expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull(),
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("holds no space for machine mail and asks nothing about it", async () => {
    renderStrip({ labels: [], from: "Acme <no-reply@acme.example>" });

    expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull();
    await flush();
    expect(requested("/api/user/inbox-insights")).toBe(false);
    expect(requested("/api/user/thread-brief")).toBe(false);
  });

  // In All inboxes the screen's account may not own the open thread.
  it("asks for everything with the account that owns the thread", async () => {
    renderStrip({ labels: ["Label_reply"] });
    await screen.findByText(SUMMARY);

    expect(requested("/api/user/thread-brief")).toBe(true);
    expect(
      mocks.requests.every((r) => r.emailAccountId === THREAD_ACCOUNT),
    ).toBe(true);
    expect(
      mocks.requests.find((r) => r.url.startsWith("/api/user/thread-brief"))
        ?.url,
    ).toContain("messageId=m1");
  });

  it("shows for mail Cue sorted without a label, from the rules it ran", async () => {
    mocks.plans = [{ status: "APPLIED", rule: { systemType: "TO_REPLY" } }];
    renderStrip({ labels: [] });

    expect(await screen.findByText(SUMMARY)).toBeTruthy();
  });

  it("drafts a reply through the reader", async () => {
    const props = renderStrip({ labels: ["Label_reply"] });
    const strip = await screen.findByRole("region", { name: "Cue summary" });

    fireEvent.click(
      await within(strip).findByRole("button", { name: "Draft reply" }),
    );
    expect(props.onDraftReply).toHaveBeenCalledTimes(1);
  });

  // The toolbar (or the phone's bottom bar) already has these on screen.
  it("never repeats the reader's own Archive, Snooze or Add to calendar", async () => {
    renderStrip({ labels: ["Label_reply"] });
    const strip = await screen.findByRole("region", { name: "Cue summary" });
    await within(strip).findByText(SUMMARY);

    for (const name of [/archive/i, /snooze/i, /calendar/i]) {
      expect(within(strip).queryByRole("button", { name })).toBeNull();
    }
  });

  it("opens the assistant on this email", async () => {
    const props = renderStrip({ labels: ["Label_reply"] });

    fireEvent.click(
      await screen.findByRole("button", { name: "Ask Cue about this email" }),
    );
    expect(props.onAskCue).toHaveBeenCalledTimes(1);
  });

  it("doesn't offer the assistant when it can't see this thread", async () => {
    renderStrip({ labels: ["Label_reply"], onAskCue: undefined });
    await screen.findByText(SUMMARY);

    expect(
      screen.queryByRole("button", { name: "Ask Cue about this email" }),
    ).toBeNull();
  });

  it("says Cue is drafting while the reply is being worked out", async () => {
    renderStrip({
      labels: ["Label_reply"],
      reply: { canRequest: true, drafts: true, pending: true },
    });

    const drafting = await screen.findByRole("button", { name: "Drafting…" });
    expect(drafting.getAttribute("aria-busy")).toBe("true");
  });

  it("says Reply, not Draft reply, when Cue doesn't write replies here", async () => {
    const props = renderStrip({
      labels: ["Label_reply"],
      reply: { canRequest: true, drafts: false, pending: false },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Reply" }));
    expect(props.onDraftReply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Draft reply" })).toBeNull();
  });

  it("offers no draft for a conversation the user spoke last in", async () => {
    renderStrip({
      labels: ["Label_reply"],
      reply: { canRequest: false, drafts: true, pending: false },
    });
    await screen.findByText(SUMMARY);

    expect(screen.queryByRole("button", { name: "Draft reply" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Ask Cue about this email" }),
    ).toBeTruthy();
  });
});

function renderStripWithContainer(options: Parameters<typeof renderStrip>[0]) {
  renderStrip(options);
  return { container: document.body };
}

function renderStrip(
  {
    labels,
    enabled = true,
    from = "Maya Patel <maya@example.com>",
    reply = { canRequest: true, drafts: true, pending: false },
    ...overrides
  }: {
    labels: string[];
    enabled?: boolean;
    from?: string;
    reply?: { canRequest: boolean; drafts: boolean; pending: boolean };
    onAskCue?: (() => void) | undefined;
  },
  swr: { errorRetryInterval?: number } = {},
) {
  const props: ComponentProps<typeof CueStrip> = {
    emailAccountId: THREAD_ACCOUNT,
    threadId: "t1",
    messages: [message("m1", ["INBOX", ...labels], from)],
    userLabels: LABELS,
    newestIsIncoming: true,
    enabled,
    reply,
    onDraftReply: vi.fn(),
    onAskCue: vi.fn(),
    ...overrides,
  };
  render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        shouldRetryOnError: swr.errorRetryInterval !== undefined,
        errorRetryInterval: swr.errorRetryInterval,
        dedupingInterval: 0,
        fetcher,
      }}
    >
      <CueStrip {...props} />
    </SWRConfig>,
  );
  return props;
}

async function fetcher(key: string | [string, string]) {
  const [url, emailAccountId] = Array.isArray(key) ? key : [key, undefined];
  mocks.requests.push({ url, emailAccountId });
  if (url.startsWith("/api/user/thread-plans")) return { plans: mocks.plans };
  if (url.startsWith("/api/user/thread-brief"))
    return { brief: { summary: SUMMARY, keyPoints: [], source: "ai" } };
  if (url.startsWith("/api/user/inbox-insights") && mocks.insightFailures > 0) {
    mocks.insightFailures -= 1;
    throw new Error("Gmail is busy for this account");
  }
  if (url.startsWith("/api/user/inbox-insights"))
    return {
      insights: mocks.insight
        ? { t1: { insight: mocks.insight, meeting: null, reply: null } }
        : {},
    };
  if (url.startsWith("/api/user/save-destinations")) return { calendar: false };
  throw new Error(`Unexpected request ${url}`);
}

function requested(path: string) {
  return mocks.requests.some((r) => r.url.startsWith(path));
}

async function waitForRequest(path: string) {
  await vi.waitFor(() => expect(requested(path)).toBe(true));
  await flush();
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function message(id: string, labelIds: string[], from: string) {
  return {
    id,
    threadId: "t1",
    labelIds,
    headers: {
      from,
      to: "user@example.com",
      subject: "Your start date",
      date: new Date(0).toISOString(),
    },
  } as unknown as ThreadMessage;
}
