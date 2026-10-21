import { describe, expect, it, vi } from "vitest";
import { getReaderPrefetchPlan } from "@/app/(app)/[emailAccountId]/mail/reader-prefetch-plan";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import type { EmailLabels } from "@/providers/email-label-types";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

vi.mock("@/env", () => ({ env: {} }));

const LABELS: EmailLabels = {
  Label_reply: { id: "Label_reply", name: "To Reply" },
  Label_news: { id: "Label_news", name: "Newsletter" },
};
const ME = "me@example.com";

describe("getReaderPrefetchPlan", () => {
  it("prefetches the brief and context for a conversation waiting on the user", () => {
    expect(plan({ labels: ["INBOX", "Label_reply"] })).toEqual({
      messageId: "m-real",
      brief: true,
      context: true,
    });
  });

  it("prefetches the brief when Cue's note asks the user to reply", () => {
    expect(plan({ insight: { action: "reply" } })?.brief).toBe(true);
  });

  it("skips the brief, a model call, for bulk mail whatever the note says", () => {
    expect(
      plan({ labels: ["Label_news"], insight: { action: "reply" } })?.brief,
    ).toBe(false);
  });

  it("skips the brief until the row's note has come", () => {
    expect(plan({ insightData: undefined })?.brief).toBe(false);
  });

  it("skips the brief when Cue's note doesn't ask for anything", () => {
    expect(plan({ insight: { action: "none" } })?.brief).toBe(false);
  });

  it("without AI access, prefetches the brief only for a conversation category", () => {
    expect(
      plan({ insight: { action: "reply" }, hasAiAccess: false })?.brief,
    ).toBe(false);
    expect(plan({ labels: ["Label_reply"], hasAiAccess: false })?.brief).toBe(
      true,
    );
  });

  it("skips related context once the user wrote the newest message", () => {
    expect(plan({ from: `Me <${ME}>` })?.context).toBe(false);
    expect(plan({ labels: ["SENT"] })?.context).toBe(false);
  });

  it("prefetches nothing for a conversation with a draft", () => {
    expect(plan({ labels: ["DRAFT", "Label_reply"] })).toBeNull();
  });
});

function plan({
  labels = ["INBOX"],
  from = "Sarah <sarah@example.com>",
  insight,
  insightData = insight
    ? ({ insight, meeting: null, reply: null } as unknown as ThreadInsightData)
    : ({ insight: null, meeting: null, reply: null } as ThreadInsightData),
  hasAiAccess = true,
}: {
  labels?: string[];
  from?: string;
  insight?: { action: string };
  insightData?: ThreadInsightData;
  hasAiAccess?: boolean;
} = {}) {
  const thread = {
    id: "t1",
    latestMessageId: "m-real",
    snippet: "",
    plans: [],
    messages: [
      {
        id: "t1:p:0",
        threadId: "t1",
        labelIds: labels,
        headers: { from, to: ME, date: "", subject: "" },
      },
    ],
  } as unknown as ListThread;
  return getReaderPrefetchPlan({
    thread,
    insightData,
    userLabels: LABELS,
    accountEmail: ME,
    hasAiAccess,
  });
}
