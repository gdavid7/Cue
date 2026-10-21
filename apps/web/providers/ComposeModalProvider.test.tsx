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
import { MAIL_SHORTCUT_SCOPES } from "@/lib/shortcuts/registry";
import { ShortcutsProvider } from "@/lib/shortcuts/ShortcutsProvider";
import { useShortcuts } from "@/lib/shortcuts/useShortcuts";
import { beginRumAction, cancelRumAction } from "@/utils/analytics/rum-actions";
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

const COLD_RENDER_TIMEOUT_MS = 5000;

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
vi.mock("@/utils/actions/scheduled-email", () => ({
  cancelHeldSendAction: vi.fn(),
}));

vi.mock("@/utils/analytics/rum-actions", () => ({
  beginRumAction: vi.fn(),
  cancelRumAction: vi.fn(),
}));

// Stands in for the composer, which sends through whichever account it is scoped to.
vi.mock(
  "@/app/(app)/[emailAccountId]/compose/ComposeEmailFormLazy",
  async () => {
    const { useAccount } = await import("./EmailAccountProvider");
    return {
      ComposeEmailFormLazy: ({ initialTo }: { initialTo?: string }) => {
        const { emailAccountId, userEmail } = useAccount();
        return (
          <div data-initial-to={initialTo ?? ""} data-testid="composer">
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

    // The file's first render pays the cold start (1.3 s idle), which can pass
    // findBy's 1 s default when the whole suite runs in parallel.
    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Pop out" },
        { timeout: COLD_RENDER_TIMEOUT_MS },
      ),
    );

    expect(
      (
        await screen.findByTestId(
          "composer",
          {},
          { timeout: COLD_RENDER_TIMEOUT_MS },
        )
      ).textContent,
    ).toBe("account-b b@outlook.com");
  });

  it("never opens another account's reply under the account in the URL", async () => {
    renderProvider();

    fireEvent.click(await screen.findByRole("button", { name: "Pop out" }));
    // Opening loads the account list; the reply must stay closed once it lands.
    await act(async () => {});

    expect(screen.queryByTestId("composer")).toBeNull();
  });
});

describe("ComposeModalProvider open timing", () => {
  beforeEach(() => {
    navigation.pathname = "/account-a/mail";
    navigation.search = "";
    vi.clearAllMocks();
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

  it("drops the open timing when compose closes by any route, such as Escape", async () => {
    renderProvider();
    fireEvent.click(await screen.findByRole("button", { name: "Compose" }));
    await screen.findByTestId("composer");
    expect(beginRumAction).toHaveBeenCalledWith("compose_open");
    expect(cancelRumAction).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("composer")).toBeNull());
    expect(cancelRumAction).toHaveBeenCalledWith("compose_open");
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

  it("starts a new message to someone, and the next one blank", async () => {
    renderProvider();
    fireEvent.click(
      await screen.findByRole("button", { name: "Write to Ana" }),
    );
    expect(
      (await screen.findByTestId("composer")).getAttribute("data-initial-to"),
    ).toBe("ana@example.com");

    fireEvent.click(screen.getByRole("button", { name: "Close compose" }));
    fireEvent.click(screen.getByRole("button", { name: "Compose" }));

    expect(
      (await screen.findByTestId("composer")).getAttribute("data-initial-to"),
    ).toBe("");
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

  // Moving a draft to another account makes the form inert and parks focus
  // on compose itself; what the user keeps typing must not triage mail.
  it("keeps keys typed while compose itself holds focus away from mail shortcuts", async () => {
    const archive = vi.fn();
    renderProvider({ archive });
    fireEvent.click(await screen.findByRole("button", { name: "Compose" }));
    await screen.findByTestId("composer");
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: "e", code: "KeyE" });
    expect(archive).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "e", code: "KeyE" });
    expect(archive).toHaveBeenCalledOnce();
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

function renderProvider({
  withTooltip = false,
  archive,
}: {
  withTooltip?: boolean;
  archive?: () => void;
} = {}) {
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <EmailAccountProvider>
        <ComposeModalProvider>
          {archive && (
            <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
              <ArchiveShortcut archive={archive} />
            </ShortcutsProvider>
          )}
          {withTooltip ? (
            <Tooltip content="Write a new email">
              <ComposeButton />
            </Tooltip>
          ) : (
            <ComposeButton />
          )}
          <PopOutButton />
          <ComposeToButton />
        </ComposeModalProvider>
      </EmailAccountProvider>
    </SWRConfig>,
  );
}

function ArchiveShortcut({ archive }: { archive: () => void }) {
  useShortcuts({ archive });
  return null;
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

function ComposeToButton() {
  const { composeTo } = useComposeModal();
  return (
    <button onClick={() => composeTo("ana@example.com")} type="button">
      Write to Ana
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
