// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { DragEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFileDropTarget } from "./useFileDropTarget";

describe("useFileDropTarget", () => {
  it("stays active while the drag crosses child elements", () => {
    const { result } = renderHook(() =>
      useFileDropTarget({ enabled: true, onDrop: vi.fn() }),
    );

    act(() => result.current.handlers.onDragEnter(fileDrag()));
    act(() => result.current.handlers.onDragEnter(fileDrag()));
    act(() => result.current.handlers.onDragLeave(fileDrag()));
    expect(result.current.active).toBe(true);

    act(() => result.current.handlers.onDragLeave(fileDrag()));
    expect(result.current.active).toBe(false);
  });

  it("ignores text and links being dragged", () => {
    const { result } = renderHook(() =>
      useFileDropTarget({ enabled: true, onDrop: vi.fn() }),
    );
    const textDrag = fileDrag({ types: ["text/plain"], files: [] });

    act(() => result.current.handlers.onDragEnter(textDrag));
    act(() => result.current.handlers.onDragOver(textDrag));

    expect(result.current.active).toBe(false);
    expect(textDrag.preventDefault).not.toHaveBeenCalled();
  });

  it.each([
    ["a PDF", "report.pdf", "application/pdf"],
    ["a spreadsheet", "budget.xlsx", "application/vnd.ms-excel"],
    ["a zip archive", "photos.zip", "application/zip"],
    ["an image", "photo.png", "image/png"],
  ])("hands over %s and keeps the browser from opening it", (_, name, type) => {
    const onDrop = vi.fn();
    const { result } = renderHook(() =>
      useFileDropTarget({ enabled: true, onDrop }),
    );
    const file = new File(["x"], name, { type });
    const over = fileDrag({ files: [file] });
    const drop = fileDrag({ files: [file] });

    act(() => result.current.handlers.onDragEnter(fileDrag()));
    act(() => result.current.handlers.onDragOver(over));
    act(() => result.current.handlers.onDrop(drop));

    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("copy");
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledWith([file]);
    expect(result.current.active).toBe(false);
  });

  it("still keeps the browser from opening files while it can't take them", () => {
    const onDrop = vi.fn();
    const { result } = renderHook(() =>
      useFileDropTarget({ enabled: false, onDrop }),
    );
    const over = fileDrag();
    const drop = fileDrag();

    act(() => result.current.handlers.onDragEnter(fileDrag()));
    act(() => result.current.handlers.onDragOver(over));
    act(() => result.current.handlers.onDrop(drop));

    expect(result.current.active).toBe(false);
    expect(over.dataTransfer.dropEffect).toBe("none");
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("clears the target when something inside takes the drop", () => {
    const { result } = renderHook(() =>
      useFileDropTarget({ enabled: true, onDrop: vi.fn() }),
    );

    act(() => result.current.handlers.onDragEnter(fileDrag()));
    act(() => result.current.handlers.onDragEnter(fileDrag()));
    act(() => result.current.reset());
    expect(result.current.active).toBe(false);

    // A fresh drag starts from zero rather than the count left behind.
    act(() => result.current.handlers.onDragEnter(fileDrag()));
    act(() => result.current.handlers.onDragLeave(fileDrag()));
    expect(result.current.active).toBe(false);
  });
});

function fileDrag({
  types = ["Files"],
  files = [new File(["x"], "file.txt", { type: "text/plain" })],
}: {
  types?: string[];
  files?: File[];
} = {}) {
  return {
    preventDefault: vi.fn(),
    dataTransfer: { types, files, dropEffect: "" },
  } as unknown as DragEvent & { preventDefault: ReturnType<typeof vi.fn> };
}
