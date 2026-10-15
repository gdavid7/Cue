/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxPreviewList, InboxPreviewSeed } from "./InboxPreviewList";

const account = vi.hoisted(() => ({ emailAccountId: "acc-1" }));
const navigation = vi.hoisted(() => ({ pathname: "/mail/u/0/inbox" }));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: account.emailAccountId,
    userEmail: "me@example.com",
  }),
}));
vi.mock("@/providers/EmailLabelsProvider", () => ({
  useEmailLabels: () => ({ userLabels: {} }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/ThreadList", () => ({
  ThreadList: ({ threads }: { threads: { id: string }[] }) => (
    <div aria-label="Conversations" role="listbox">
      {threads.map((thread) => (
        <span data-mail-thread-subject key={thread.id}>
          {thread.id}
        </span>
      ))}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  account.emailAccountId = "acc-1";
  navigation.pathname = "/mail/u/0/inbox";
});

describe("InboxPreviewList", () => {
  it("shows the inbox's newest conversations from one server call while mail loads", async () => {
    const fetcher = vi.fn(async () => ({
      threads: [thread("t1"), thread("t2")],
      nextPageToken: null,
    }));
    renderWithSwr(
      <InboxPreviewList message="Opening your mailbox…" />,
      fetcher,
    );

    expect(screen.getByText("Opening your mailbox…")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getAllByText(/^t\d$/).map((row) => row.textContent),
      ).toEqual(["t1", "t2"]),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith([
      "/api/threads?view=list&type=inbox&limit=25",
      "acc-1",
    ]);
  });

  it("asks for the open account's mail only", async () => {
    account.emailAccountId = "acc-2";
    const fetcher = vi.fn(async () => ({ threads: [], nextPageToken: null }));
    renderWithSwr(
      <InboxPreviewList message="Opening your mailbox…" />,
      fetcher,
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith([
      "/api/threads?view=list&type=inbox&limit=25",
      "acc-2",
    ]);
  });

  it("keeps the skeleton for views other than the inbox", () => {
    navigation.pathname = "/mail/u/0/sent";
    const fetcher = vi.fn();
    renderWithSwr(
      <InboxPreviewList message="Opening your mailbox…" />,
      fetcher,
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows rows the server started fetching with the page, without asking again", async () => {
    const fetcher = vi.fn();
    const preview = Promise.resolve({
      threads: [thread("s1")],
      nextPageToken: null,
    });
    // Suspense resolves inside an async act.
    await act(async () => {
      renderWithSwr(
        <InboxPreviewSeed emailAccountId="acc-1" preview={preview}>
          <InboxPreviewList message="Opening your mailbox…" />
        </InboxPreviewSeed>,
        fetcher,
      );
    });

    expect(await screen.findByText("s1")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the server's rows when a later render arrives without them", async () => {
    const fetcher = vi.fn();
    const preview = Promise.resolve({
      threads: [thread("s1")],
      nextPageToken: null,
    });
    const cache = new Map();
    const view = await act(async () =>
      render(
        <SWRConfig value={{ fetcher, provider: () => cache }}>
          <InboxPreviewSeed emailAccountId="acc-1" preview={preview}>
            <InboxPreviewList message="Opening your mailbox…" />
          </InboxPreviewSeed>
        </SWRConfig>,
      ),
    );
    await screen.findByText("s1");

    // A server action re-rendered the layout, which no longer seeds.
    await act(async () =>
      view.rerender(
        <SWRConfig value={{ fetcher, provider: () => cache }}>
          <InboxPreviewList message="Opening your mailbox…" />
        </SWRConfig>,
      ),
    );

    expect(screen.getByText("s1")).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never shows rows the server fetched for another account", async () => {
    account.emailAccountId = "acc-2";
    const fetcher = vi.fn(async () => ({
      threads: [thread("own")],
      nextPageToken: null,
    }));
    renderWithSwr(
      <InboxPreviewSeed
        emailAccountId="acc-1"
        preview={Promise.resolve({
          threads: [thread("s1")],
          nextPageToken: null,
        })}
      >
        <InboxPreviewList message="Opening your mailbox…" />
      </InboxPreviewSeed>,
      fetcher,
    );

    expect(await screen.findByText("own")).toBeTruthy();
    expect(screen.queryByText("s1")).toBeNull();
  });

  it("keeps the skeleton when the caller turns the preview off", () => {
    const fetcher = vi.fn();
    renderWithSwr(
      <InboxPreviewList enabled={false} message="Loading your mail…" />,
      fetcher,
    );

    expect(fetcher).not.toHaveBeenCalled();
  });
});

function renderWithSwr(ui: ReactNode, fetcher: (...args: never[]) => unknown) {
  return render(
    <SWRConfig value={{ fetcher, provider: () => new Map() }}>{ui}</SWRConfig>,
  );
}

function thread(id: string) {
  return {
    id,
    messageIds: [`${id}-m`],
    snippet: "",
    plans: [],
    messages: [
      {
        id: `${id}-m`,
        threadId: id,
        snippet: "",
        subject: id,
        date: "2026-10-15T00:00:00.000Z",
        internalDate: "1",
        labelIds: ["INBOX"],
        headers: {
          from: "ada@example.com",
          to: "me@example.com",
          subject: id,
          date: "",
        },
      },
    ],
  };
}
