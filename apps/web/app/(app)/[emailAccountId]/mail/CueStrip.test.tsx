// @vitest-environment jsdom

import {
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
}));

vi.mock("@/env", () => ({ env: {} }));
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

  it("asks for nothing until the conversation is actually open", async () => {
    renderStrip({ labels: ["Label_reply"], enabled: false });

    await flush();
    expect(screen.queryByRole("region", { name: "Cue summary" })).toBeNull();
    expect(requested("/api/user/thread-brief")).toBe(false);
    expect(requested("/api/user/thread-plans")).toBe(false);
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

  it("drafts a reply, snoozes and archives with the reader's own actions", async () => {
    const props = renderStrip({ labels: ["Label_reply"] });
    const strip = await screen.findByRole("region", { name: "Cue summary" });

    fireEvent.click(
      await within(strip).findByRole("button", { name: "Draft reply" }),
    );
    expect(props.onDraftReply).toHaveBeenCalledTimes(1);

    fireEvent.click(within(strip).getByRole("button", { name: "Archive" }));
    expect(props.onArchive).toHaveBeenCalledTimes(1);

    fireEvent.click(within(strip).getByRole("button", { name: "Snooze" }));
    const snooze = await screen.findByRole("dialog", { name: "Snooze until" });
    fireEvent.click(within(snooze).getAllByRole("button")[0]);
    expect(props.onSnooze).toHaveBeenCalledWith(expect.any(Date));
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
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  });
});

function renderStrip({
  labels,
  enabled = true,
  reply = { canRequest: true, drafts: true, pending: false },
  ...overrides
}: {
  labels: string[];
  enabled?: boolean;
  reply?: { canRequest: boolean; drafts: boolean; pending: boolean };
  onAskCue?: (() => void) | undefined;
}) {
  const props: ComponentProps<typeof CueStrip> = {
    emailAccountId: THREAD_ACCOUNT,
    threadId: "t1",
    messages: [message("m1", ["INBOX", ...labels])],
    userLabels: LABELS,
    subject: "Your start date",
    enabled,
    reply,
    onDraftReply: vi.fn(),
    onArchive: vi.fn(),
    onSnooze: vi.fn(),
    onAskCue: vi.fn(),
    ...overrides,
  };
  render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        shouldRetryOnError: false,
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
  if (url.startsWith("/api/user/inbox-insights")) return { insights: {} };
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

function message(id: string, labelIds: string[]) {
  return {
    id,
    threadId: "t1",
    labelIds,
    headers: {
      from: "Maya Patel <maya@example.com>",
      to: "user@example.com",
      subject: "Your start date",
      date: new Date(0).toISOString(),
    },
  } as unknown as ThreadMessage;
}
