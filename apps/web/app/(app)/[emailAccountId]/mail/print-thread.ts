import { format } from "date-fns";
import type { ParsedMessage } from "@/utils/types";
import {
  getPreparedEmailHtml,
  sanitizeEmailHtml,
} from "@/utils/email/prepare-html.client";
import { escapeHtml } from "@/utils/string";

type PrintableMessage = Pick<
  ParsedMessage,
  "id" | "headers" | "textHtml" | "textPlain" | "snippet"
>;

/**
 * Prints the conversation from a hidden frame. The frame is sandboxed without
 * scripts, so nothing in an email can run while it is laid out for printing.
 */
export function printThread({
  subject,
  messages,
}: {
  subject: string;
  messages: PrintableMessage[];
}) {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.srcdoc = buildPrintableThreadHtml({
    subject,
    messages: messages.map((message) => ({
      from: message.headers.from,
      to: message.headers.to,
      cc: message.headers.cc,
      date: message.headers.date,
      bodyHtml: printableBody(message),
    })),
  });
  frame.addEventListener("load", () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // Printing blocks until the dialog closes; afterwards the frame can go.
    setTimeout(() => frame.remove(), 1000);
  });
  document.body.appendChild(frame);
}

export function buildPrintableThreadHtml({
  subject,
  messages,
}: {
  subject: string;
  messages: {
    from: string;
    to?: string;
    cc?: string;
    date: string;
    bodyHtml: string;
  }[];
}) {
  const sections = messages
    .map(
      (message) => `<section class="message">
<dl>
<dt>From</dt><dd>${escapeHtml(message.from)}</dd>
${message.to ? `<dt>To</dt><dd>${escapeHtml(message.to)}</dd>` : ""}
${message.cc ? `<dt>Cc</dt><dd>${escapeHtml(message.cc)}</dd>` : ""}
<dt>Date</dt><dd>${escapeHtml(formatPrintDate(message.date))}</dd>
</dl>
<div class="body">${message.bodyHtml}</div>
</section>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: blob:; style-src 'unsafe-inline'">
<title>${escapeHtml(subject)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #111; margin: 24px; }
h1 { font-size: 20px; margin: 0 0 16px; }
.message { border-top: 1px solid #ccc; padding: 12px 0; break-inside: auto; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 8px; font-size: 12px; margin: 0 0 12px; }
dt { color: #555; }
dd { margin: 0; }
.body { font-size: 14px; overflow-wrap: anywhere; }
.body img { max-width: 100%; height: auto; }
pre { white-space: pre-wrap; font-family: inherit; margin: 0; }
</style>
</head>
<body>
<h1>${escapeHtml(subject)}</h1>
${sections}
</body>
</html>`;
}

function printableBody(message: PrintableMessage) {
  if (message.textHtml) {
    const sanitized = sanitizeEmailHtml(message.textHtml).html;
    // The reader's copy routes remote images through the image proxy.
    const html =
      getPreparedEmailHtml({ messageId: message.id, sourceHtml: sanitized }) ??
      sanitized;
    return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  }
  return `<pre>${escapeHtml(message.textPlain || message.snippet || "")}</pre>`;
}

function formatPrintDate(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : format(parsed, "PPpp");
}
