// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanAction } from "@/generated/prisma/enums";
import type { CleanThread } from "@/utils/redis/clean.types";
import { EmailItem } from "./EmailFirehoseItem";

vi.mock("@/utils/actions/clean", () => ({
  undoCleanInboxAction: vi.fn(),
  changeKeepToDoneAction: vi.fn(),
}));

const thread: CleanThread = {
  emailAccountId: "account-1",
  threadId: "thread-1",
  jobId: "job-1",
  status: "completed",
  createdAt: "2026-10-19T00:00:00.000Z",
  date: new Date("2026-10-18T00:00:00.000Z"),
  archive: true,
};

describe("EmailItem", () => {
  afterEach(cleanup);

  // RD-3: the feed carries ids only; the sender and subject come from mail
  // the browser looked up.
  it("shows the sender and subject the browser looked up", () => {
    renderItem({ subject: "Weekly digest", from: "News <news@example.com>" });

    expect(screen.getByText("Weekly digest")).toBeTruthy();
    expect(screen.getByText(/From: News <news@example.com>/)).toBeTruthy();
  });

  it("holds the row while its details load", () => {
    renderItem(undefined);

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText(/From:/)).toBeNull();
  });
});

function renderItem(details: { subject: string; from: string } | undefined) {
  render(
    <EmailItem
      email={thread}
      details={details}
      userEmail="me@example.com"
      emailAccountId="account-1"
      action={CleanAction.ARCHIVE}
      setUndoing={vi.fn()}
      setUndone={vi.fn()}
    />,
  );
}
