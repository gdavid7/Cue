// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanelResizeHandle } from "./ChatPanelResizeHandle";
import {
  CHAT_PANEL_DEFAULT_WIDTH,
  CHAT_PANEL_MIN_WIDTH,
  clampChatPanelWidth,
  resetChatPanelWidth,
  useChatPanelWidth,
} from "@/hooks/useChatPanelWidth";

const STORAGE_KEY = "cue:chat-panel-width";

beforeEach(() => {
  setViewportWidth(1600);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => resetChatPanelWidth());
  window.localStorage.clear();
});

describe("clampChatPanelWidth", () => {
  it("keeps the panel between its minimum and 60% of the viewport", () => {
    expect(clampChatPanelWidth(100, 1600)).toBe(CHAT_PANEL_MIN_WIDTH);
    expect(clampChatPanelWidth(700, 1600)).toBe(700);
    expect(clampChatPanelWidth(5000, 1600)).toBe(960);
  });

  it("never lets the maximum fall below the minimum on narrow windows", () => {
    expect(clampChatPanelWidth(900, 500)).toBe(CHAT_PANEL_MIN_WIDTH);
  });
});

describe("ChatPanelResizeHandle", () => {
  it("starts at the default width when nothing is stored", () => {
    renderHandle();

    expect(separator().getAttribute("aria-valuenow")).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH),
    );
    expect(screen.getByTestId("width").textContent).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH),
    );
  });

  it("restores a stored width, clamped to the current window", () => {
    window.localStorage.setItem(STORAGE_KEY, "720");
    setViewportWidth(1000);
    renderHandle();

    expect(separator().getAttribute("aria-valuenow")).toBe("600");
  });

  it("ignores a corrupt stored width", () => {
    window.localStorage.setItem(STORAGE_KEY, "wide");
    renderHandle();

    expect(separator().getAttribute("aria-valuenow")).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH),
    );
  });

  it("widens while dragging left and saves the width on release", () => {
    renderHandle();
    const handle = separator();

    fireEvent.pointerDown(handle, { clientX: 1150, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 1050, pointerId: 1 });

    expect(screen.getByTestId("width").textContent).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH + 100),
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    fireEvent.pointerUp(handle, { clientX: 1050, pointerId: 1 });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH + 100),
    );
    expect(handle.getAttribute("aria-valuenow")).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH + 100),
    );
  });

  it("stops at 60% of the viewport however far it is dragged", () => {
    renderHandle();
    const handle = separator();

    fireEvent.pointerDown(handle, { clientX: 1150, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 0, pointerId: 1 });

    expect(handle.getAttribute("aria-valuenow")).toBe("960");
  });

  it("resizes with the arrow keys and saves each step", () => {
    renderHandle();
    const handle = separator();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    const widened = Number(handle.getAttribute("aria-valuenow"));
    expect(widened).toBeGreaterThan(CHAT_PANEL_DEFAULT_WIDTH);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(widened));

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH),
    );

    fireEvent.keyDown(handle, { key: "End" });
    expect(handle.getAttribute("aria-valuenow")).toBe("960");

    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe(
      String(CHAT_PANEL_MIN_WIDTH),
    );
  });

  it("resets to the default on double-click and forgets the stored width", () => {
    window.localStorage.setItem(STORAGE_KEY, "800");
    renderHandle();
    const handle = separator();
    expect(handle.getAttribute("aria-valuenow")).toBe("800");

    fireEvent.doubleClick(handle);

    expect(handle.getAttribute("aria-valuenow")).toBe(
      String(CHAT_PANEL_DEFAULT_WIDTH),
    );
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps resizing for the session when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderHandle();
    const handle = separator();

    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(Number(handle.getAttribute("aria-valuenow"))).toBeGreaterThan(
      CHAT_PANEL_DEFAULT_WIDTH,
    );
  });
});

function renderHandle() {
  render(
    <>
      <ChatPanelResizeHandle />
      <Width />
    </>,
  );
}

function Width() {
  return <output data-testid="width">{useChatPanelWidth()}</output>;
}

function separator() {
  return screen.getByRole("separator", { name: "Resize assistant panel" });
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}
