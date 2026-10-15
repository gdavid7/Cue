/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadsListResponse } from "@/app/api/threads/route";
import {
  InboxPreviewList,
  InboxPreviewSeed,
  useFetchOpenedPreviewThreads,
  useRetireInboxPreview,
} from "./InboxPreviewList";

const account = vi.hoisted(() => ({ emailAccountId: "acc-1" }));
const navigation = vi.hoisted(() => ({ pathname: "/mail/u/0/inbox" }));
const engine = vi.hoisted(() => ({ client: null as unknown }));
const mailClient = vi.hoisted(() => ({
  ensureMessageContent: vi.fn(async () => ({ status: "scheduled" })),
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => engine.client,
}));

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
  ThreadList: ({
    threads,
    onOpenThread,
  }: {
    threads: { id: string }[];
    onOpenThread: (index: number) => void;
  }) => (
    <div aria-label="Conversations" role="listbox">
      {threads.map((thread, index) => (
        <button
          data-mail-thread-subject
          key={thread.id}
          onClick={() => onOpenThread(index)}
          type="button"
        >
          {thread.id}
        </button>
      ))}
    </div>
  ),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  mailClient.ensureMessageContent.mockClear();
  engine.client = null;
  account.emailAccountId = "acc-1";
  navigation.pathname = "/mail/u/0/inbox";
});

describe("InboxPreviewList", () => {
  it("shows the inbox the server started fetching with the page", async () => {
    await renderSeeded(previewOf("s1", "s2"));

    expect(screen.getAllByText(/^s\d$/).map((row) => row.textContent)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("asks the provider for nothing on a warm open, which has no seed", async () => {
    await act(async () => {
      render(seeded(null));
    });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("Opening your mailbox…")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never shows rows the server fetched for another account", async () => {
    account.emailAccountId = "acc-2";

    await renderSeeded(previewOf("s1"));

    expect(screen.queryByText("s1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the rows and the mail screen when the layout re-renders without a seed", async () => {
    const view = await renderSeeded(previewOf("s1"));

    // A server action re-renders the layout, which then carries no seed.
    await act(async () => {
      view.rerender(seeded(null));
    });

    expect(screen.getByText("s1")).toBeTruthy();
    expect(screen.getByTestId("screen").textContent).toBe("mounted 1");
  });

  it("puts the seeded rows away for good once the engine has shown mail", async () => {
    await renderSeeded(previewOf("s1"));

    await act(async () => {
      fireEvent.click(screen.getByText("engine has mail"));
    });

    expect(screen.queryByText("s1")).toBeNull();
    expect(screen.getByText("Opening your mailbox…")).toBeTruthy();
  });

  it("falls back to the skeleton when the seed fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    await renderSeeded(Promise.reject(new Error("stream broke")));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByText("Opening your mailbox…")).toBeTruthy();
  });

  it("keeps the skeleton for views other than the inbox", async () => {
    navigation.pathname = "/mail/u/0/sent";

    await renderSeeded(previewOf("s1"));

    expect(screen.queryByText("s1")).toBeNull();
  });

  it("opens a conversation clicked before the engine is ready once it is", async () => {
    window.history.replaceState(null, "", "/mail/u/0/inbox");
    await renderSeeded(previewOf("t1", "t2"));

    fireEvent.click(screen.getByText("t2"));

    // The mail screen opens the conversation in the address when it mounts.
    expect(window.location.pathname).toBe("/mail/u/0/inbox/t2");
  });

  it("has the engine fetch a conversation clicked before its sync reaches it", async () => {
    window.history.replaceState(null, "", "/mail/u/0/inbox");
    const view = await renderSeeded(previewOf("t1", "t2"));

    fireEvent.click(screen.getByText("t2"));
    expect(mailClient.ensureMessageContent).not.toHaveBeenCalled();

    // The engine opens later; older inbox mail syncs only in the backfill.
    engine.client = mailClient;
    await act(async () => {
      view.rerender(seeded(null));
    });

    expect(mailClient.ensureMessageContent.mock.calls).toEqual([
      [{ accountId: "acc-1", messageId: "t2-m" }],
    ]);
    await act(async () => {
      view.rerender(seeded(null));
    });
    expect(mailClient.ensureMessageContent).toHaveBeenCalledTimes(1);
  });
});

let mounts = 0;

function Screen() {
  const [mountedAs] = useState(() => {
    mounts += 1;
    return mounts;
  });
  const retire = useRetireInboxPreview();
  useFetchOpenedPreviewThreads();
  return (
    <>
      <span data-testid="screen">{`mounted ${mountedAs}`}</span>
      <button onClick={retire} type="button">
        engine has mail
      </button>
      <InboxPreviewList message="Opening your mailbox…" />
    </>
  );
}

function seeded(preview: Promise<ThreadsListResponse | null> | null) {
  return (
    <InboxPreviewSeed emailAccountId="acc-1" preview={preview}>
      <Screen />
    </InboxPreviewSeed>
  );
}

async function renderSeeded(preview: Promise<ThreadsListResponse | null>) {
  mounts = 0;
  let view: ReturnType<typeof render> | undefined;
  // Suspense resolves inside an async act.
  await act(async () => {
    view = render(seeded(preview));
  });
  await act(async () => {
    await preview.catch(() => undefined);
  });
  if (!view) throw new Error("not rendered");
  return view;
}

function previewOf(...ids: string[]) {
  return Promise.resolve({
    threads: ids.map((id) => thread(id)),
    nextPageToken: null,
  } as unknown as ThreadsListResponse);
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
