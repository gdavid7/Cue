// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehindSidebarRight, SidebarRight } from "@/components/SidebarRight";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

const screenSize = vi.hoisted(() => ({ isLarge: false }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => !screenSize.isLarge,
  useIsLargeScreen: () => screenSize.isLarge,
}));

// Stands in for the chat, with an inner layer that handles Escape itself and
// is portaled out of the panel, the way Radix menus and dialogs are.
vi.mock("@/components/assistant-chat/chat", () => ({
  Chat: () => <InnerLayer />,
}));

beforeEach(() => {
  screenSize.isLarge = false;
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
});

function renderPanel() {
  return render(
    <SidebarProvider defaultOpen={[]} sidebarNames={["chat-sidebar"]}>
      <BehindSidebarRight name="chat-sidebar">
        <Page />
      </BehindSidebarRight>
      <SidebarRight name="chat-sidebar" />
    </SidebarProvider>,
  );
}

function Page() {
  const { toggleSidebar } = useSidebar();

  return (
    <button type="button" onClick={() => toggleSidebar(["chat-sidebar"])}>
      Ask Cue
    </button>
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
