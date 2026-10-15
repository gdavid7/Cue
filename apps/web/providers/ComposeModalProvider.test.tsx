// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { SWRConfig } from "swr";
import { Tooltip } from "@/components/Tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeModalProvider, useComposeModal } from "./ComposeModalProvider";
import { EmailAccountProvider, useAccount } from "./EmailAccountProvider";

// The real tooltip positions itself with floating-ui, which observes size.
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

const navigation = vi.hoisted(() => ({
  pathname: "/account-a/mail",
  search: "",
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ emailAccountId: "account-a" }),
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

vi.mock("@/utils/fetch-email-accounts", () => ({
  EMAIL_ACCOUNTS_KEY: "/api/user/email-accounts",
  fetchEmailAccounts: vi.fn(async () => ({
    emailAccounts: [
      account("account-a", "a@gmail.com", "google"),
      account("account-b", "b@outlook.com", "microsoft"),
    ],
    lastEmailAccountId: "account-a",
  })),
  subscribeEmailAccounts: () => () => {},
}));

vi.mock("@/utils/actions/email-account-cookie", () => ({
  setLastEmailAccountAction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/actions/mail", () => ({ deleteDraftAction: vi.fn() }));

// Stands in for the composer, which sends through whichever account it is scoped to.
vi.mock(
  "@/app/(app)/[emailAccountId]/compose/ComposeEmailFormLazy",
  async () => {
    const { useAccount } = await import("./EmailAccountProvider");
    return {
      ComposeEmailFormLazy: () => {
        const { emailAccountId, userEmail } = useAccount();
        return (
          <div data-testid="composer">
            {emailAccountId} {userEmail}
          </div>
        );
      },
    };
  },
);

describe("ComposeModalProvider popped-out reply", () => {
  beforeEach(() => {
    navigation.pathname = "/account-a/mail";
    navigation.search = "";
    // jsdom has no matchMedia; the provider reads it to pick the phone layout.
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("composes a reply from the account that received it in All inboxes", async () => {
    navigation.pathname = "/mail/u/0/all-inboxes";
    renderProvider();

    fireEvent.click(await screen.findByRole("button", { name: "Pop out" }));

    expect((await screen.findByTestId("composer")).textContent).toBe(
      "account-b b@outlook.com",
    );
  });

  it("never opens another account's reply under the account in the URL", async () => {
    renderProvider();

    fireEvent.click(await screen.findByRole("button", { name: "Pop out" }));
    // Opening loads the account list; the reply must stay closed once it lands.
    await act(async () => {});

    expect(screen.queryByTestId("composer")).toBeNull();
  });
});

describe("ComposeModalProvider focus", () => {
  beforeEach(() => {
    navigation.pathname = "/account-a/mail";
    navigation.search = "";
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Full-screen compose covers the inbox, so Tab must not walk into it.
  it("shuts out the page behind expanded compose without remounting the draft", async () => {
    renderProvider();
    const opener = await screen.findByRole("button", { name: "Compose" });
    fireEvent.click(opener);
    const composer = await screen.findByTestId("composer");
    expect(opener.closest("[inert]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand compose" }));

    expect(opener.closest("[inert]")).not.toBeNull();
    expect(screen.getByTestId("composer")).toBe(composer);

    fireEvent.click(screen.getByRole("button", { name: "Restore compose" }));
    expect(opener.closest("[inert]")).toBeNull();
  });

  it("returns focus to what opened compose when it closes", async () => {
    renderProvider();
    const opener = await screen.findByRole("button", { name: "Compose" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("composer");

    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));

    expect(screen.queryByTestId("composer")).toBeNull();
    // Radix restores focus a task after the dialog unmounts.
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  // Docked compose sits beside the inbox, so the user may have moved on to
  // another row; pulling focus back would make Enter open the stale one.
  it("leaves focus where the user moved it outside compose", async () => {
    renderProvider();
    const opener = await screen.findByRole("button", { name: "Compose" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("composer");
    const elsewhere = screen.getByRole("button", { name: "Pop out" });
    elsewhere.focus();

    fireEvent.keyDown(elsewhere, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("composer")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(elsewhere);
  });

  // The sidebar's Compose tooltip opens below it, over the Inbox link, and
  // swallowed clicks there until focus moved on.
  it("returns focus to Compose without opening its tooltip", async () => {
    renderProvider({ withTooltip: true });
    const opener = await screen.findByRole("button", { name: "Compose" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByTestId("composer");

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("still shows the Compose tooltip when Tab lands on it", async () => {
    renderProvider({ withTooltip: true });
    const opener = await screen.findByRole("button", { name: "Compose" });

    fireEvent.keyDown(document.body, { key: "Tab" });
    opener.focus();

    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Write a new email",
    );
  });
});

function renderProvider({ withTooltip = false } = {}) {
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <EmailAccountProvider>
        <ComposeModalProvider>
          {withTooltip ? (
            <Tooltip content="Write a new email">
              <ComposeButton />
            </Tooltip>
          ) : (
            <ComposeButton />
          )}
          <PopOutButton />
        </ComposeModalProvider>
      </EmailAccountProvider>
    </SWRConfig>,
  );
}

function ComposeButton(props: ComponentProps<"button">) {
  const { onOpen } = useComposeModal();
  return (
    <button
      {...props}
      onClick={(event) => {
        props.onClick?.(event);
        onOpen();
      }}
      type="button"
    >
      Compose
    </button>
  );
}

function PopOutButton() {
  const { emailAccountId } = useAccount();
  const { popOutReply } = useComposeModal();
  if (emailAccountId !== "account-a") return null;
  return (
    <button
      onClick={() =>
        popOutReply({
          emailAccountId: "account-b",
          draftSessionId: "message-b:reply",
          draftKeyMessageId: "message-b",
          draftMode: "reply",
          replyingToEmail: {
            to: "sender@example.com",
            subject: "Re: Hello",
            threadId: "thread-b",
            messageId: "message-b",
            draftHtml: "",
            quotedContentHtml: "",
          },
        })
      }
      type="button"
    >
      Pop out
    </button>
  );
}

function account(id: string, email: string, provider: string) {
  return {
    id,
    email,
    name: null,
    image: null,
    account: { provider },
    providerRateLimit: null,
  };
}
