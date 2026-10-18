import { type DragEvent, useRef, useState } from "react";

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

function carriesFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}
