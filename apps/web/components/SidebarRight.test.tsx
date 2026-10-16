// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SidebarRight,
  useSidebarRightCoversPage,
} from "@/components/SidebarRight";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

const screenSize = vi.hoisted(() => ({ isLarge: false }));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => !screenSize.isLarge,
  useIsLargeScreen: () => screenSize.isLarge,
}));

// Stands in for the chat, with an inner layer that handles Escape itself the
// way Radix menus and dialogs do.
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
      <Page />
      <SidebarRight name="chat-sidebar" />
    </SidebarProvider>,
  );
}

function Page() {
  const { toggleSidebar } = useSidebar();
  const coversPage = useSidebarRightCoversPage("chat-sidebar");

  return (
    <div inert={coversPage}>
      <button type="button" onClick={() => toggleSidebar(["chat-sidebar"])}>
        Ask Cue
      </button>
    </div>
  );
}

function InnerLayer() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open layer
      </button>
      {open ? (
        <div
          role="menu"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
