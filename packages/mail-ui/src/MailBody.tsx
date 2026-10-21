import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { linkifyPlainText } from "./linkify";
import { sanitizeMailHtml } from "./sanitize-html";
import {
  adaptMailDocumentForDarkMode,
  DARK_MAIL_SURFACE,
  hasAuthoredDarkSupport,
} from "./dark-adapt";

const SANS_FONT_STACK = `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const BODY_TYPE = { fontSize: "14.5px", lineHeight: 1.65 } as const;
const DARK_SURFACE_CSS = `rgb(${DARK_MAIL_SURFACE.r}, ${DARK_MAIL_SURFACE.g}, ${DARK_MAIL_SURFACE.b})`;

export const EMAIL_DOCUMENT_MARKER = "inbox-zero-email-document";

export type MailPlainTextSegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string };

export type MailHtmlFrameCallbacks = {
  onForwardMessage?: () => void;
  onReplyMessage?: () => void;
  onNavigateMessage?: (direction: -1 | 1) => void;
  onFocusMessage?: () => void;
};

type MailHtmlDocument = {
  srcDoc: string;
  documentKey: string;
};

/**
 * How an email is colored in the reader. "theme" restyles plain emails with
 * the app's palette; "authored" applies the sender's own dark styles; "adapt"
 * recolors a light designed email for the dark surface once it renders;
 * "light" shows it as sent.
 */
export type MailDarkTreatment = "light" | "theme" | "authored" | "adapt";

export function MailMessageBody({
  html,
  text,
  messageId,
  isDarkMode = false,
  imageProxyBaseUrl = null,
  imageProxyOrigin = null,
  allowRemoteImages = false,
}: {
  html?: string | null;
  text?: string | null;
  messageId: string;
  isDarkMode?: boolean;
  imageProxyBaseUrl?: string | null;
  imageProxyOrigin?: string | null;
  allowRemoteImages?: boolean;
}) {
  const document = useMemo(() => {
    if (!html) return null;
    const sanitizedHtml = sanitizeMailHtml(html);
    const darkTreatment = getMailDarkTreatment(sanitizedHtml, {
      isDarkMode,
      adaptDesignedEmails: false,
    });
    const documentKey = getMailHtmlDocumentKey(
      `${messageId}:${sanitizedHtml}`,
      darkTreatment,
    );
    return {
      documentKey,
      darkTreatment,
      srcDoc: buildMailHtmlDocument({
        html: sanitizedHtml,
        darkTreatment,
        imageProxyBaseUrl,
        imageProxyOrigin,
        documentKey,
        allowRemoteImages,
      }),
    };
  }, [
    allowRemoteImages,
    html,
    imageProxyBaseUrl,
    imageProxyOrigin,
    isDarkMode,
    messageId,
  ]);

  if (document) {
    return (
      <div className="relative min-w-0 overflow-x-hidden">
        <BufferedMailHtmlFrame
          callbacks={{}}
          documentKey={document.documentKey}
          darkTreatment={document.darkTreatment}
          srcDoc={document.srcDoc}
        />
      </div>
    );
  }

  return <LinkifiedPlainTextBody text={text ?? ""} />;
}

export function MailPlainTextBody({
  segments,
  className,
}: {
  segments: MailPlainTextSegment[];
  className?: string;
}) {
  return (
    <pre
      className={[
        "whitespace-pre-wrap font-sans text-foreground [overflow-wrap:anywhere]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={BODY_TYPE}
    >
      {segments.map((segment, index) =>
        segment.type === "link" ? (
          <a
            className="text-primary underline underline-offset-2"
            href={segment.href}
            key={`${segment.href}-${index}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {segment.text}
          </a>
        ) : (
          <Fragment key={`${index}-${segment.text}`}>{segment.text}</Fragment>
        ),
      )}
    </pre>
  );
}

export function BufferedMailHtmlFrame({
  srcDoc,
  documentKey,
  darkTreatment,
  callbacks,
  label,
}: MailHtmlDocument & {
  darkTreatment: MailDarkTreatment;
  callbacks: MailHtmlFrameCallbacks;
  /** The frame's accessible name, such as who sent the message and when. */
  label?: string;
}) {
  const [visibleDocument, setVisibleDocument] = useState<MailHtmlDocument>(
    () => ({
      srcDoc,
      documentKey,
    }),
  );
  const nextDocument = useMemo(
    () => ({ srcDoc, documentKey }),
    [srcDoc, documentKey],
  );
  const documents =
    visibleDocument.documentKey !== documentKey
      ? [visibleDocument, nextDocument]
      : [nextDocument];

  return (
    <div className="relative min-w-0">
      {documents.map((document, index) => (
        <MailHtmlFrame
          key={document.documentKey}
          document={document}
          pending={index > 0}
          darkTreatment={darkTreatment}
          onReady={setVisibleDocument}
          callbacks={callbacks}
          label={label}
        />
      ))}
    </div>
  );
}

export function buildMailHtmlDocument({
  html,
  darkTreatment,
  imageProxyBaseUrl,
  imageProxyOrigin,
  documentKey,
  allowRemoteImages = true,
}: {
  html: string;
  darkTreatment: MailDarkTreatment;
  imageProxyBaseUrl: string | null;
  imageProxyOrigin: string | null;
  documentKey: string;
  allowRemoteImages?: boolean;
}) {
  const styleAttributeCount = (html.match(/style=/gi) || []).length;
  const hasHeavyStyling = isDesignedHtmlEmail(html);

  const hasMinimalStyling =
    !hasHeavyStyling &&
    (html.includes("color:") ||
      html.includes("text-decoration") ||
      styleAttributeCount === 1);

  // The sender's dark styles paint their own body over the reader's surface.
  const authoredDark = darkTreatment === "authored";
  const defaultFontCss = hasHeavyStyling
    ? `
      :root {
        color-scheme: ${authoredDark ? "dark" : "light"};
        background-color: ${authoredDark ? DARK_SURFACE_CSS : "white"};
      }
      body {
        ${authoredDark ? "" : "background-color: white;"}
        font-family: ${SANS_FONT_STACK};
        overflow-wrap: anywhere;
      }
      table { max-width: 100% !important; overflow-x: auto; }
      img { max-width: 100% !important; height: auto; }
  `
    : `
      :root {
        color-scheme: light;
        --foreground: 222.2 47.4% 11.2%;
        --muted-foreground: 215.4 16.3% 46.9%;
        --background: 0 0% 100%;
        background-color: hsl(var(--background));
      }

      .dark {
        color-scheme: dark;
        --foreground: 220 8% 92%;
        --muted-foreground: 220 5% 67%;
        --background: 220 7% 19%;
      }

      table { max-width: 100% !important; overflow-x: auto; }
      img { max-width: 100% !important; height: auto; }

      body {
        font-family: ${SANS_FONT_STACK};
        overflow-wrap: anywhere;
      }
      body:not([style]):not([bgcolor]) {
        margin: 0;
        font-size: ${BODY_TYPE.fontSize};
        line-height: ${BODY_TYPE.lineHeight};
        color: hsl(var(--foreground));
        background-color: hsl(var(--background));
      }

      blockquote:not([style]), .gmail_quote:not([style]) {
        color: hsl(var(--muted-foreground));
        border-left: 3px solid hsl(var(--muted-foreground) / 0.2);
        margin: 0;
        padding-left: 1rem;
      }

      a {
        color: ${hasMinimalStyling ? "inherit" : "hsl(var(--foreground))"};
        text-decoration: underline;
      }

      .gmail_quote:not([style]), .gmail_quote:not([style]) * {
        color: hsl(var(--muted-foreground));
      }

      ${
        hasMinimalStyling
          ? `
      [style*="color"] {
        color: inherit !important;
      }
      `
          : ""
      }
  `;

  const imageSourceDirective =
    imageProxyBaseUrl && imageProxyOrigin && html.includes(imageProxyBaseUrl)
      ? imageProxyOrigin
      : allowRemoteImages
        ? "https:"
        : "";
  const localImageSourceDirective = html.includes("blob:")
    ? "data: blob:"
    : "data:";
  const imageSourceDirectives = [
    localImageSourceDirective,
    imageSourceDirective,
  ]
    .filter(Boolean)
    .join(" ");

  const contentSecurityPolicy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src ${imageSourceDirectives}`,
    "font-src 'none'",
    "media-src 'none'",
    "connect-src 'none'",
    "manifest-src 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "script-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  return buildStructuredMailHtmlDocument({
    html,
    darkTreatment,
    documentKey,
    contentSecurityPolicy,
    defaultFontCss,
    hasHeavyStyling,
  });
}

/**
 * Plain emails always follow the app's theme. A designed email in dark mode
 * uses the sender's own dark styles when it has them, otherwise it is adapted
 * unless the reader asked to see it as sent.
 */
export function getMailDarkTreatment(
  html: string,
  {
    isDarkMode,
    adaptDesignedEmails,
  }: { isDarkMode: boolean; adaptDesignedEmails: boolean },
): MailDarkTreatment {
  if (!isDarkMode) return "light";
  if (!isDesignedHtmlEmail(html)) return "theme";
  if (!adaptDesignedEmails) return "light";
  return hasAuthoredDarkSupport(html) ? "authored" : "adapt";
}

export function getMailHtmlDocumentKey(
  html: string,
  darkTreatment: MailDarkTreatment,
) {
  const source = `${darkTreatment}:${html}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${source.length}-${(hash >>> 0).toString(36)}`;
}

function MailHtmlFrame({
  document,
  pending,
  darkTreatment,
  onReady,
  callbacks,
  label,
}: {
  document: MailHtmlDocument;
  pending: boolean;
  label?: string;
  darkTreatment: MailDarkTreatment;
  onReady: (document: MailHtmlDocument) => void;
  callbacks: MailHtmlFrameCallbacks;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const height = useMailHtmlFrame(
    iframeRef,
    document.srcDoc,
    document.documentKey,
    darkTreatment === "adapt",
    callbacks,
  );
  useLayoutEffect(() => {
    if (height) onReady(document);
  }, [document, height, onReady]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={document.srcDoc}
      className="min-h-0 w-full"
      data-email-ready={height > 0}
      height={1}
      style={{
        height: height ? `${height}px` : undefined,
        position: pending ? "absolute" : undefined,
        top: pending ? 0 : undefined,
        visibility: pending ? "hidden" : undefined,
        colorScheme: usesDarkColorScheme(darkTreatment) ? "dark" : "light",
      }}
      aria-hidden={pending || undefined}
      // Names each message's frame apart; the title stays generic.
      aria-label={label}
      title={
        pending ? "Preparing email content preview" : "Email content preview"
      }
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
    />
  );
}

function useMailHtmlFrame(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  srcDoc: string,
  documentKey: string,
  adaptForDarkMode: boolean,
  callbacks: MailHtmlFrameCallbacks,
) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [measurement, setMeasurement] = useState<{
    documentKey: string;
    height: number;
  }>();

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let animationFrameId: number | undefined;
    let observedRoot: HTMLElement | null = null;
    let observedDocument: Document | null = null;

    const selectMessage = () => callbacksRef.current.onFocusMessage?.();
    const navigateMessage = (event: KeyboardEvent) => {
      const navigate = callbacksRef.current.onNavigateMessage;
      const reply = callbacksRef.current.onReplyMessage;
      const forward = callbacksRef.current.onForwardMessage;
      const key = event.key.toLowerCase();
      const isNavigationKey = ["ArrowUp", "ArrowDown"].includes(event.key);
      const handlesKey =
        (event.key === "Enter" && Boolean(reply)) ||
        (key === "f" && Boolean(forward)) ||
        (isNavigationKey && Boolean(navigate));
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing ||
        observedDocument?.getSelection()?.isCollapsed === false
      )
        return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest?.(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        )
      )
        return;
      if (event.key === "Enter" && target?.closest?.("a, button")) return;
      if (!handlesKey) {
        forwardShortcut(event);
        return;
      }
      event.preventDefault();
      if (event.key === "Enter") reply?.();
      else if (key === "f") forward?.();
      else navigate?.(event.key === "ArrowUp" ? -1 : 1);
    };
    const forwardShortcut = (event: KeyboardEvent) => {
      const forwarded = new KeyboardEvent(event.type, {
        key: event.key,
        code: event.code,
        location: event.location,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      });
      if (!iframe.dispatchEvent(forwarded)) event.preventDefault();
    };
    const stopObservingDocument = () => {
      observedDocument?.removeEventListener("keydown", navigateMessage);
      observedDocument?.removeEventListener("keyup", forwardShortcut);
      observedDocument?.removeEventListener("pointerdown", selectMessage);
      observedDocument?.removeEventListener("focusin", selectMessage);
    };

    const updateHeight = () => {
      const iframeDocument = iframe.contentDocument;
      if (!iframeDocument) return;
      const { body, documentElement } = iframeDocument;
      if (!body || !documentElement) return;

      // scrollHeight rounds to the nearest pixel, so a fractional content
      // height can come out a pixel short and leave the frame scrollable.
      const newHeight = Math.max(
        documentElement.scrollHeight,
        body.scrollHeight,
        Math.ceil(documentElement.getBoundingClientRect().height),
      );
      if (newHeight) setMeasurement({ documentKey, height: newHeight });
    };

    const resizeObserver = new ResizeObserver(updateHeight);

    const observeDocument = () => {
      if (iframe.srcdoc !== srcDoc) return false;
      const iframeDocument = iframe.contentDocument;
      if (!iframeDocument) return false;
      const marker = iframeDocument.querySelector(
        `meta[name="${EMAIL_DOCUMENT_MARKER}"]`,
      );
      if (marker?.getAttribute("content") !== documentKey) return false;
      const { body, documentElement: root } = iframeDocument;
      if (!body || !root) return false;
      if (root === observedRoot) return true;
      if (adaptForDarkMode) {
        // The frame stays one pixel tall until it is measured, so recoloring
        // the whole document first means it never shows the light version.
        if (iframeDocument.readyState === "loading") return false;
        adaptMailDocumentForDarkMode(iframeDocument);
      }

      resizeObserver.disconnect();
      stopObservingDocument();
      observedDocument = iframeDocument;
      observedDocument.addEventListener("keydown", navigateMessage);
      observedDocument.addEventListener("keyup", forwardShortcut);
      observedDocument.addEventListener("pointerdown", selectMessage);
      observedDocument.addEventListener("focusin", selectMessage);
      observedRoot = root;
      updateHeight();
      resizeObserver.observe(root);
      resizeObserver.observe(body);
      return true;
    };

    const stopWatchingForDocument = () => {
      if (animationFrameId === undefined) return;
      cancelAnimationFrame(animationFrameId);
      animationFrameId = undefined;
    };

    const watchForDocument = () => {
      if (observeDocument()) {
        animationFrameId = undefined;
        return;
      }
      animationFrameId = requestAnimationFrame(watchForDocument);
    };

    const onLoad = () => {
      if (!observeDocument()) return;
      updateHeight();
      stopWatchingForDocument();
    };

    iframe.addEventListener("load", onLoad);
    if (!observeDocument()) {
      animationFrameId = requestAnimationFrame(watchForDocument);
    }

    return () => {
      iframe.removeEventListener("load", onLoad);
      stopWatchingForDocument();
      resizeObserver.disconnect();
      stopObservingDocument();
    };
  }, [iframeRef, srcDoc, documentKey, adaptForDarkMode]);

  return measurement?.documentKey === documentKey ? measurement.height : 0;
}

export function isDesignedHtmlEmail(html: string) {
  const markup = html.toLowerCase();
  const styleAttributeCount = (markup.match(/style=/g) || []).length;
  return (
    markup.includes("bgcolor") ||
    markup.includes("background") ||
    markup.includes("<style") ||
    styleAttributeCount > 1 ||
    markup.includes("font-family") ||
    markup.includes("font-size")
  );
}

type StructuredMailHtmlDocumentInput = {
  html: string;
  darkTreatment: MailDarkTreatment;
  documentKey: string;
  contentSecurityPolicy: string;
  defaultFontCss: string;
  hasHeavyStyling: boolean;
};

function buildStructuredMailHtmlDocument({
  html,
  darkTreatment,
  documentKey,
  contentSecurityPolicy,
  defaultFontCss,
  hasHeavyStyling,
}: StructuredMailHtmlDocumentInput) {
  const mailDocument = new DOMParser().parseFromString(html || "", "text/html");

  if (hasHeavyStyling) {
    pinAuthoredColorScheme(mailDocument, darkTreatment === "authored");
  }
  if (darkTreatment === "adapt" && mailDocument.body) {
    // Outlook.com marks a document it has recolored this way, and senders key
    // their own corrections for that recoloring off these attributes.
    mailDocument.body.setAttribute("data-ogsc", "");
    mailDocument.body.setAttribute("data-ogsb", "");
  }

  prependMailDocumentHead(mailDocument, {
    documentKey,
    isDarkMode: usesDarkColorScheme(darkTreatment),
    contentSecurityPolicy,
    defaultFontCss,
  });
  applyDarkModeClass(mailDocument, darkTreatment === "theme");

  return `<!doctype html>
${mailDocument.documentElement.outerHTML}`;
}

/**
 * The frame's own color-scheme preference follows the operating system, not
 * the app, so the sender's light and dark media queries are pinned to the
 * palette the reader chose.
 */
function pinAuthoredColorScheme(mailDocument: Document, dark: boolean) {
  const always = "(min-width: 0px)";
  const never = "(max-width: 0px)";
  for (const stylesheet of mailDocument.querySelectorAll("style")) {
    stylesheet.textContent = (stylesheet.textContent ?? "")
      .replace(
        /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi,
        dark ? always : never,
      )
      .replace(
        /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi,
        dark ? never : always,
      );
  }
}

function usesDarkColorScheme(darkTreatment: MailDarkTreatment) {
  return darkTreatment === "theme" || darkTreatment === "authored";
}

function prependMailDocumentHead(
  mailDocument: Document,
  {
    documentKey,
    isDarkMode,
    contentSecurityPolicy,
    defaultFontCss,
  }: {
    documentKey: string;
    isDarkMode: boolean;
    contentSecurityPolicy: string;
    defaultFontCss: string;
  },
) {
  const marker = mailDocument.createElement("meta");
  marker.name = EMAIL_DOCUMENT_MARKER;
  marker.content = documentKey;

  const colorScheme = mailDocument.createElement("meta");
  colorScheme.name = "color-scheme";
  colorScheme.content = isDarkMode ? "dark" : "light";

  const csp = mailDocument.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = contentSecurityPolicy;

  const contentTypeOptions = mailDocument.createElement("meta");
  contentTypeOptions.httpEquiv = "X-Content-Type-Options";
  contentTypeOptions.content = "nosniff";

  const defaultStyles = mailDocument.createElement("style");
  defaultStyles.textContent = defaultFontCss;

  const base = mailDocument.createElement("base");
  base.target = "_blank";
  base.setAttribute("rel", "noopener noreferrer");

  mailDocument.head.prepend(
    marker,
    colorScheme,
    csp,
    contentTypeOptions,
    defaultStyles,
    base,
  );
}

function applyDarkModeClass(mailDocument: Document, isDarkMode: boolean) {
  if (!isDarkMode) return;

  mailDocument.documentElement.classList.add("dark");
  mailDocument.body.classList.add("dark");
}

function LinkifiedPlainTextBody({ text }: { text: string }) {
  const segments = useMemo(() => linkifyPlainText(text), [text]);
  return <MailPlainTextBody segments={segments} />;
}
