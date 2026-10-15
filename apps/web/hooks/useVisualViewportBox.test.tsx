// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useVisualViewportBox } from "@/hooks/useVisualViewportBox";

let viewport: FakeVisualViewport;

beforeEach(() => {
  viewport = new FakeVisualViewport(844);
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: viewport,
  });
});

afterEach(cleanup);

describe("useVisualViewportBox", () => {
  it("sizes the panel to the area the keyboard leaves visible", () => {
    const panel = renderPanel(true);
    expect(boxOf(panel)).toEqual({ height: "844px", top: "0px" });

    viewport.change({ height: 508, offsetTop: 120 });

    expect(boxOf(panel)).toEqual({ height: "508px", top: "120px" });
  });

  it("returns to full height when the keyboard closes", () => {
    const panel = renderPanel(true);
    viewport.change({ height: 508, offsetTop: 0 });

    viewport.change({ height: 844, offsetTop: 0 });

    expect(boxOf(panel).height).toBe("844px");
  });

  it("leaves the panel alone when disabled", () => {
    const panel = renderPanel(false);
    viewport.change({ height: 508, offsetTop: 0 });

    expect(boxOf(panel)).toEqual({ height: "", top: "" });
  });

  it("stops tracking and clears the size once unmounted", () => {
    const panel = renderPanel(true);
    cleanup();

    viewport.change({ height: 508, offsetTop: 0 });

    expect(boxOf(panel)).toEqual({ height: "", top: "" });
    expect(viewport.listenerCount).toBe(0);
  });
});

function renderPanel(enabled: boolean) {
  function Panel() {
    return <div data-testid="panel" ref={useVisualViewportBox(enabled)} />;
  }
  const { getByTestId } = render(<Panel />);
  return getByTestId("panel");
}

function boxOf(element: HTMLElement) {
  return {
    height: element.style.getPropertyValue("--visual-viewport-height"),
    top: element.style.getPropertyValue("--visual-viewport-top"),
  };
}

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  listenerCount = 0;

  constructor(height: number) {
    super();
    this.height = height;
  }

  override addEventListener(
    ...args: Parameters<EventTarget["addEventListener"]>
  ) {
    this.listenerCount++;
    super.addEventListener(...args);
  }

  override removeEventListener(
    ...args: Parameters<EventTarget["removeEventListener"]>
  ) {
    this.listenerCount--;
    super.removeEventListener(...args);
  }

  change(next: { height: number; offsetTop: number }) {
    this.height = next.height;
    this.offsetTop = next.offsetTop;
    this.dispatchEvent(new Event("resize"));
    this.dispatchEvent(new Event("scroll"));
  }
}
