import { type DragEvent, useEffect, useRef, useState } from "react";

/**
 * Shows a drop target while files are dragged over an element. Drag events
 * fire for every child the pointer crosses, so entries are counted rather
 * than toggled. Dropped files never fall through to the browser, which would
 * open the file in place of the app and lose the draft.
 */
export function useFileDropTarget({
  enabled,
  onDrop,
}: {
  enabled: boolean;
  onDrop: (files: File[]) => void;
}) {
  const depth = useRef(0);
  const [active, setActive] = useState(false);
  const reset = () => {
    depth.current = 0;
    setActive(false);
  };

  // A file let go just outside the composer (its frame, the page behind it)
  // would still open in the tab. Drops something else on the page handles,
  // and file inputs, keep their own behavior.
  useEffect(() => {
    const keepFileInTab = (event: globalThis.DragEvent) => {
      if (event.defaultPrevented || !carriesFiles(event)) return;
      if (
        event.target instanceof HTMLInputElement &&
        event.target.type === "file"
      )
        return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", keepFileInTab);
    window.addEventListener("drop", keepFileInTab);
    return () => {
      window.removeEventListener("dragover", keepFileInTab);
      window.removeEventListener("drop", keepFileInTab);
    };
  }, []);

  return {
    active: active && enabled,
    reset,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      },
      onDragOver: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = enabled ? "copy" : "none";
      },
      onDragLeave: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setActive(false);
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        reset();
        const files = Array.from(event.dataTransfer.files);
        if (enabled && files.length) onDrop(files);
      },
    },
  };
}

function carriesFiles(event: { dataTransfer: DataTransfer | null }) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}
