"use client";

import { renderAsync } from "docx-preview";
import { useEffect, useRef, useState } from "react";
import {
  PREVIEW_UNAVAILABLE,
  PreviewMessage,
  PreviewSpinner,
} from "@/components/email-list/AttachmentPreviewStatus";
import {
  createFrameElementFactory,
  DOCX_FRAME_DOCUMENT,
  DOCX_RENDER_OPTIONS,
  fitDocxToFrame,
  handleFrameLinkAuxClick,
  handleFrameLinkClick,
} from "@/utils/attachments/docx-frame";

/**
 * Renders a Word document in the browser; the file never leaves the device.
 * It lands in a sandboxed frame without scripts whose CSP blocks every
 * network load (see DOCX_FRAME_DOCUMENT), and its links open in a new tab
 * rather than navigating the frame.
 */
export default function DocxAttachmentPreview({
  file,
  filename,
}: {
  file: Blob;
  filename: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading",
  );

  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    const styles = doc?.getElementById("docx-styles");
    const body = doc?.getElementById("docx-body");
    if (!frameReady || !doc || !styles || !body) return;
    let cancelled = false;
    const open = (url: string) =>
      window.open(url, "_blank", "noopener,noreferrer");
    const onClick = (event: MouseEvent) => handleFrameLinkClick(event, open);
    const onAuxClick = (event: MouseEvent) =>
      handleFrameLinkAuxClick(event, open);
    doc.addEventListener("click", onClick);
    doc.addEventListener("auxclick", onAuxClick);
    const frame = frameRef.current;
    const resizeObserver = new ResizeObserver(() => fitDocxToFrame(doc));
    renderAsync(file, body, styles, {
      ...DOCX_RENDER_OPTIONS,
      h: createFrameElementFactory(doc),
    }).then(
      () => {
        if (cancelled) return;
        // Observing reports the frame's current size, which runs the first fit.
        if (frame) resizeObserver.observe(frame);
        setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      doc.removeEventListener("click", onClick);
      doc.removeEventListener("auxclick", onAuxClick);
      styles.replaceChildren();
      body.replaceChildren();
    };
  }, [file, frameReady]);

  if (status === "failed")
    return <PreviewMessage>{PREVIEW_UNAVAILABLE}</PreviewMessage>;

  return (
    <>
      <iframe
        className="size-full border-0 bg-muted/40"
        onLoad={() => setFrameReady(true)}
        ref={frameRef}
        // Same origin so this page can write the document in; no
        // allow-scripts, so nothing in it runs.
        sandbox="allow-same-origin"
        srcDoc={DOCX_FRAME_DOCUMENT}
        title={filename}
      />
      {status === "loading" ? (
        <div className="absolute">
          <PreviewSpinner />
        </div>
      ) : null}
    </>
  );
}
