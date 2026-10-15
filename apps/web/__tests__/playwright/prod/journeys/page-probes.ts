import type { Page } from "@playwright/test";

// Functions that run inside the page. `installJourneyProbes` is an init
// script, so it runs before the app on every document: it notes when the mail
// stream reports changes, copies the chat's response stream as it arrives
// (the answer text, tool errors and first-token time come from it), and adds
// up layout shift. Every function here must stay self-contained.

type ChatProbe = {
  path: string;
  status: number;
  startedAt: number;
  firstTextAt: number | null;
  endedAt: number | null;
  raw: string;
};

export type JourneyProbeState = {
  cls: number;
  mailEvents: { type: string; at: number }[];
  chat: ChatProbe[];
};

export const MAX_STREAM_CHARS = 400_000;

/**
 * Pass `MAX_STREAM_CHARS` as the init script's argument: the function is
 * serialized into the page, where module constants do not exist.
 */
export function installJourneyProbes(maxStreamChars: number) {
  const scope = window as unknown as {
    __cueJourney?: JourneyProbeState;
    EventSource: typeof EventSource;
  };
  if (scope.__cueJourney) return;
  const state: JourneyProbeState = { cls: 0, mailEvents: [], chat: [] };
  scope.__cueJourney = state;

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
        };
        if (!shift.hadRecentInput) state.cls += shift.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    // Layout shift is not observable in this browser.
  }

  const NativeEventSource = scope.EventSource;
  if (NativeEventSource) {
    scope.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        if (!String(url).includes("/api/mail-stream")) return;
        for (const type of ["ready", "mailbox-change", "error"]) {
          this.addEventListener(type, () =>
            state.mailEvents.push({ type, at: Date.now() }),
          );
        }
      }
    };
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, location.href).pathname;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const isChat =
        (path === "/api/chat" && method === "POST") ||
        /^\/api\/chat\/[^/]+\/stream$/.test(path);
      if (!isChat || !response.body || response.status !== 200) {
        return response;
      }
      const probe: ChatProbe = {
        path,
        status: response.status,
        startedAt: performance.now(),
        firstTextAt: null,
        endedAt: null,
        raw: "",
      };
      state.chat.push(probe);
      const [forApp, forProbe] = response.body.tee();
      const copy = async () => {
        const reader = forProbe.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            if (
              probe.firstTextAt === null &&
              `${probe.raw.slice(-32)}${text}`.includes('"text-delta"')
            ) {
              probe.firstTextAt = performance.now();
            }
            if (probe.raw.length < maxStreamChars) probe.raw += text;
          }
        } catch {
          // The app cancelled the stream; what arrived is kept.
        } finally {
          probe.endedAt = performance.now();
        }
      };
      copy().catch(() => undefined);
      return new Response(forApp, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };
}

export async function readProbes(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __cueJourney?: JourneyProbeState })
        .__cueJourney ?? { cls: 0, mailEvents: [], chat: [] },
  );
}

/**
 * The first moment a conversation row whose subject contains `subject` is on
 * screen, on the page's `performance.now()` clock (since navigation) or, with
 * `wallClock`, as `Date.now()`.
 */
export function rowWithSubjectShown({
  subject,
  wallClock,
}: {
  subject: string;
  wallClock: boolean;
}) {
  for (const element of document.querySelectorAll(
    '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
  )) {
    if (!(element.textContent ?? "").includes(subject)) continue;
    const row = element.closest("[data-mail-thread-row]") ?? element;
    if (row.getBoundingClientRect().height > 0) {
      return wallClock ? Date.now() : performance.now();
    }
  }
  return false;
}

export function rowWithSubjectAbsent(subject: string) {
  for (const element of document.querySelectorAll("[data-mail-thread-subject]"))
    if ((element.textContent ?? "").includes(subject)) return false;
  return performance.now();
}

/** Rows are listed and every one has `word` in its subject. */
export function onlyRowsMatching(word: string) {
  const subjects = Array.from(
    document.querySelectorAll(
      '[role="listbox"][aria-label="Conversations"] [data-mail-thread-subject]',
    ),
    (element) => (element.textContent ?? "").toLowerCase(),
  );
  return subjects.length > 0 &&
    subjects.every((subject) => subject.includes(word.toLowerCase()))
    ? performance.now()
    : false;
}

export function rowWithSubjectPresent(subject: string) {
  for (const element of document.querySelectorAll("[data-mail-thread-subject]"))
    if ((element.textContent ?? "").includes(subject)) return performance.now();
  return false;
}
