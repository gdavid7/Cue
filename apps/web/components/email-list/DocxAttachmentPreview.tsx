"use client";

import { renderAsync } from "docx-preview";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Renders a Word document in the browser; the file never leaves the device.
 * The document lands in a sandboxed frame with scripts off and no network
 * (its CSP allows only inline styles and embedded images and fonts), so a
 * crafted file can neither run code nor phone home with a tracking image.
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
    const body = frameRef.current?.contentDocument?.body;
    const head = frameRef.current?.contentDocument?.head;
    if (!frameReady || !body || !head) return;
    let cancelled = false;
    renderAsync(file, body, head, {
      ignoreLastRenderedPageBreak: true,
      // Embedded images as data: URLs, which the frame's CSP allows.
      useBase64URL: true,
      renderChanges: false,
      renderComments: false,
    }).then(
      () => {
        if (!cancelled) setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
      body.replaceChildren();
    };
  }, [file, frameReady]);

  if (status === "failed")
    return (
      <p className="text-muted-foreground text-sm">
        Couldn't preview this document. Download it to open it.
      </p>
    );

  return (
    <>
      <iframe
        className="size-full border-0 bg-muted/40"
        onLoad={() => setFrameReady(true)}
        ref={frameRef}
        // Same origin so this page can write the document in; no
        // allow-scripts, so nothing in it runs.
        sandbox="allow-same-origin"
        srcDoc={FRAME_DOCUMENT}
        title={filename}
      />
      {status === "loading" ? (
        <Loader2 className="absolute size-6 animate-spin text-muted-foreground" />
      ) : null}
    </>
  );
}

const FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>html,body{margin:0;background:transparent}.docx-wrapper{background:transparent!important;padding:16px!important}</style></head><body></body></html>`;
