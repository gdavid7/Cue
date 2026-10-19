import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { setFeedbackStatusAction, submitFeedbackAction } from "./feedback";

const { authMock, envMock, fetchMock, trackProductFeedbackMock } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    envMock: {
      NODE_ENV: "test",
      ADMINS: ["founder@example.com"],
      FEEDBACK_WEBHOOK_URL: undefined as string | undefined,
    },
    fetchMock: vi.fn(),
    trackProductFeedbackMock: vi.fn(),
  }),
);

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "user-agent": "TestBrowser/1.0" })),
}));
vi.mock("@/env", () => ({ env: envMock }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: authMock }));
vi.mock("@/utils/rate-limit", () => ({
  assertWithinUserRateLimit: vi.fn(),
}));
vi.mock("@/utils/posthog", () => ({
  trackProductFeedback: trackProductFeedbackMock,
}));

const user = { user: { id: "user-1", email: "user@example.com" } };

describe("submitFeedbackAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    authMock.mockResolvedValue(user);
    envMock.FEEDBACK_WEBHOOK_URL = undefined;
    fetchMock.mockResolvedValue({ ok: true });
    trackProductFeedbackMock.mockResolvedValue(undefined);
    prisma.feedback.create.mockResolvedValue({} as never);
    prisma.emailAccount.findFirst.mockResolvedValue({ id: "ea-1" } as never);
    vi.mocked(after).mockImplementation((callback) => {
      if (typeof callback === "function") callback();
    });
  });

  it("saves the feedback for the session user", async () => {
    const result = await submitFeedbackAction({
      feedback: "Love the assistant chat",
      page: "/ea-1/mail",
      emailAccountId: "ea-1",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "ea-1", userId: "user-1" },
      select: { id: true },
    });
    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        emailAccountId: "ea-1",
        message: "Love the assistant chat",
        page: "/ea-1/mail",
        userAgent: "TestBrowser/1.0",
      },
    });
  });

  it("drops an email account the user does not own", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null);

    await submitFeedbackAction({
      feedback: "Hello",
      emailAccountId: "someone-elses",
    });

    expect(prisma.feedback.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "user-1" }),
    });
    expect(
      prisma.feedback.create.mock.calls[0][0].data.emailAccountId,
    ).toBeUndefined();
  });

  it("rejects an unauthenticated request without saving", async () => {
    authMock.mockResolvedValue(null);

    const result = await submitFeedbackAction({ feedback: "Hello" });

    expect(result?.serverError).toBeDefined();
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it("rejects a message over the length cap", async () => {
    const result = await submitFeedbackAction({ feedback: "a".repeat(5001) });

    expect(result?.validationErrors).toBeDefined();
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it("accepts a message at the length cap", async () => {
    const result = await submitFeedbackAction({ feedback: "a".repeat(5000) });

    expect(result?.validationErrors).toBeUndefined();
    expect(prisma.feedback.create).toHaveBeenCalledTimes(1);
  });

  it("rejects empty feedback", async () => {
    const result = await submitFeedbackAction({ feedback: "   " });

    expect(result?.validationErrors).toBeDefined();
    expect(prisma.feedback.create).not.toHaveBeenCalled();
  });

  it("sends feedback to PostHog and the webhook after saving", async () => {
    envMock.FEEDBACK_WEBHOOK_URL = "https://hooks.slack.com/services/test";

    await submitFeedbackAction({ feedback: "Love the assistant chat" });

    expect(trackProductFeedbackMock).toHaveBeenCalledWith(
      "user@example.com",
      "Love the assistant chat",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves long feedback across Slack section blocks", async () => {
    envMock.FEEDBACK_WEBHOOK_URL = "https://hooks.slack.com/services/test";
    const feedback = "a".repeat(5000);

    await submitFeedbackAction({ feedback });

    const payload = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    const feedbackSections = payload.blocks.slice(1);

    expect(feedbackSections).toHaveLength(2);
    expect(
      feedbackSections
        .map((block: { text: { text: string } }) => block.text.text)
        .join(""),
    ).toBe(feedback);
  });

  it("still succeeds when PostHog and the webhook fail", async () => {
    envMock.FEEDBACK_WEBHOOK_URL = "https://hooks.slack.com/services/test";
    trackProductFeedbackMock.mockRejectedValue(new Error("PostHog down"));
    fetchMock.mockRejectedValue(new Error("Slack unavailable"));

    const result = await submitFeedbackAction({ feedback: "Hello" });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.feedback.create).toHaveBeenCalledTimes(1);
  });
});

describe("setFeedbackStatusAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.feedback.update.mockResolvedValue({} as never);
  });

  it("rejects a non-admin", async () => {
    authMock.mockResolvedValue(user);

    const result = await setFeedbackStatusAction({ id: "f1", status: "DONE" });

    expect(result?.serverError).toBeDefined();
    expect(prisma.feedback.update).not.toHaveBeenCalled();
  });

  it("lets an admin set the status", async () => {
    authMock.mockResolvedValue({
      user: { id: "admin-1", email: "founder@example.com" },
    });

    const result = await setFeedbackStatusAction({ id: "f1", status: "DONE" });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.feedback.update).toHaveBeenCalledWith({
      where: { id: "f1" },
      data: { status: "DONE" },
    });
  });
});
