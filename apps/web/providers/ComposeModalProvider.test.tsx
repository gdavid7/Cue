// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeModalProvider, useComposeModal } from "./ComposeModalProvider";
import { EmailAccountProvider, useAccount } from "./EmailAccountProvider";

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
  });

  afterEach(() => {
    cleanup();
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

function renderProvider() {
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <EmailAccountProvider>
        <ComposeModalProvider>
          <PopOutButton />
        </ComposeModalProvider>
      </EmailAccountProvider>
    </SWRConfig>,
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
