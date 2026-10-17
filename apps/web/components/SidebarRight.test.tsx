// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehindSidebarRight, SidebarRight } from "@/components/SidebarRight";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

const screenSize = vi.hoisted(() => ({ isLarge: false }));
// Stands in for ChatProvider's input focus request.
const chatInput = vi.hoisted(() => ({ focusRequested: false }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => !screenSize.isLarge,
  useIsLargeScreen: () => screenSize.isLarge,
}));

// Stands in for the chat: an input that takes focus when asked to, as the real
// one does in its own effect, and an inner layer that handles Escape itself and
// is portaled out of the panel, the way Radix menus and dialogs are.
vi.mock("@/components/assistant-chat/chat", () => ({
  Chat: () => <MockChat />,
}));

beforeEach(() => {
  screenSize.isLarge = false;
  chatInput.focusRequested = false;
});

afterEach(cleanup);

describe("SidebarRight on a phone", () => {
  it("takes focus into the panel and gives it back to the opener on close", async () => {
    renderPanel();
    const opener = screen.getByRole("button", { name: "Ask Cue" });

    opener.focus();
    fireEvent.click(opener);

    const panel = await screen.findByRole("dialog", { name: "Chat" });
    await waitFor(() =>
      expect(panel.contains(document.activeElement)).toBe(true),
    );

    fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("takes what's behind it out of the tab order while open", async () => {
    renderPanel();
    const opener = screen.getByRole("button", { name: "Ask Cue" });

    expect(opener.closest("[inert]")).toBeNull();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Chat" });
    expect(opener.closest("[inert]")).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(opener.closest("[inert]")).toBeNull();
  });

  it("lets an inner layer close on Escape without closing the panel", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Ask Cue" }));
    const panel = await screen.findByRole("dialog", { name: "Chat" });
    fireEvent.click(await screen.findByRole("button", { name: "Open layer" }));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(panel.isConnected).toBe(true);

    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("claims Escape typed in the panel before the page's own shortcuts see it", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Ask Cue" }));
    const layerButton = await screen.findByRole("button", {
      name: "Open layer",
    });
    const claimedBeforePage: boolean[] = [];
    const pageShortcut = (event: KeyboardEvent) =>
      claimedBeforePage.push(event.defaultPrevented);
    document.addEventListener("keydown", pageShortcut);

    fireEvent.keyDown(layerButton, { key: "Escape" });
    document.removeEventListener("keydown", pageShortcut);

    expect(claimedBeforePage).toEqual([true]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("SidebarRight on a phone, asked to focus the chat input", () => {
  it("leaves focus in the chat input and gives it back to Ask Cue on close", async () => {
    await renderPanelWithChatLoaded();
    const askAboutEmail = screen.getByRole("button", {
      name: "Ask Cue about this email",
    });

    askAboutEmail.focus();
    fireEvent.click(askAboutEmail);

    const input = await screen.findByRole("textbox", { name: "Message Cue" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    // Focus has settled; nothing after the chat's own effect took it back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(askAboutEmail);
  });

  it("leaves focus on the page when Ask Cue is gone by the time it closes", async () => {
    const { rerender } = await renderPanelWithChatLoaded();
    fireEvent.click(
      screen.getByRole("button", { name: "Ask Cue about this email" }),
    );
    const input = await screen.findByRole("textbox", { name: "Message Cue" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    rerender(<PanelWithPage showAskAboutEmail={false} />);
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("SidebarRight beside the page", () => {
  it("closes on Escape from the page even when a page shortcut also claims it", async () => {
    screenSize.isLarge = true;
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Ask Cue" }));
    await screen.findByRole("button", { name: "Open layer" });
    // Like mail's Escape shortcut, which handles the key before the window.
    const pageShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", pageShortcut);

    fireEvent.keyDown(screen.getByRole("button", { name: "Ask Cue" }), {
      key: "Escape",
    });
    document.removeEventListener("keydown", pageShortcut);

    expect(screen.queryByRole("button", { name: "Open layer" })).toBeNull();
  });

  it("leaves Escape in a portaled inner layer to that layer", async () => {
    screenSize.isLarge = true;
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Ask Cue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open layer" }));

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Open layer" })).toBeTruthy();
  });

  it("stays a side panel and leaves the page interactive", async () => {
    screenSize.isLarge = true;
    renderPanel();
    const opener = screen.getByRole("button", { name: "Ask Cue" });

    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("button", { name: "Open layer" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  // The chat unmounts on close, so focus inside it would fall to the page.
  it("gives focus back to the opener when it closes with focus inside", async () => {
    screenSize.isLarge = true;
    renderPanel();
    const opener = screen.getByRole("button", { name: "Ask Cue" });
    opener.focus();
    fireEvent.click(opener);
    const input = await screen.findByRole("textbox", { name: "Message Cue" });
    input.focus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Message Cue" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus on the page when it closes from there", async () => {
    screenSize.isLarge = true;
    renderPanel();
    const opener = screen.getByRole("button", { name: "Ask Cue" });
    fireEvent.click(opener);
    await screen.findByRole("textbox", { name: "Message Cue" });
    const elsewhere = screen.getByRole("button", {
      name: "Ask Cue about this email",
    });
    elsewhere.focus();

    fireEvent.keyDown(elsewhere, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Message Cue" })).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});

function renderPanel() {
  return render(<PanelWithPage />);
}

// The chat loads lazily; once loaded it mounts in the same commit that opens
// the panel, so its effects run before the panel's.
async function renderPanelWithChatLoaded() {
  const result = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Ask Cue" }));
  await screen.findByRole("textbox", { name: "Message Cue" });
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  return result;
}

function PanelWithPage({ showAskAboutEmail = true }) {
  return (
    <SidebarProvider defaultOpen={[]} sidebarNames={["chat-sidebar"]}>
      <BehindSidebarRight name="chat-sidebar">
        <Page showAskAboutEmail={showAskAboutEmail} />
      </BehindSidebarRight>
      <SidebarRight name="chat-sidebar" />
    </SidebarProvider>
  );
}

function Page({ showAskAboutEmail }: { showAskAboutEmail: boolean }) {
  const { toggleSidebar, setOpenMobile } = useSidebar();

  return (
    <>
      <button type="button" onClick={() => toggleSidebar(["chat-sidebar"])}>
        Ask Cue
      </button>
      {showAskAboutEmail ? (
        <button
          type="button"
          onClick={() => {
            chatInput.focusRequested = true;
            setOpenMobile((open) => [...open, "chat-sidebar"]);
          }}
        >
          Ask Cue about this email
        </button>
      ) : null}
    </>
  );
}

function MockChat() {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!chatInput.focusRequested) return;
    inputRef.current?.focus();
    chatInput.focusRequested = false;
  }, []);

  return (
    <>
      <textarea aria-label="Message Cue" ref={inputRef} />
      <InnerLayer />
    </>
  );
}

function InnerLayer() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open layer
      </button>
      {open
        ? createPortal(
            <div
              role="menu"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                setOpen(false);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
