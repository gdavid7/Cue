import { expect, type Page, type Route } from "@playwright/test";
import {
  type QaMailboxCredentials,
  waitForSignInCode,
} from "@/scripts/qa/qa-mailbox";
import { rememberAppOrigin } from "@/utils/playwright/app-origin";

// Signing in as the QA account and keeping its writes to itself, shared by
// the hourly smoke robot and the journeys robot.

const SIGN_IN_CODE_TIMEOUT_MS = 150_000;

/** Cue refused or never sent the code; `note` says what to do about it. */
export class SignInRefusedError extends Error {
  readonly note: string;

  constructor(message: string, note: string) {
    super(message);
    this.note = note;
  }
}

/**
 * Signs in with a one-time code read from the QA inbox and waits for
 * Settings. Records `codeDeliveryMs` and `signInMs` into `metrics`.
 */
export async function signInWithEmailCode(
  page: Page,
  credentials: QaMailboxCredentials,
  metrics: Record<string, number | boolean>,
) {
  await page.goto("/login/email?next=%2Fsettings", {
    waitUntil: "domcontentloaded",
  });
  const emailField = page.getByLabel("Email", { exact: true });
  await expect(emailField, "the Email field is on /login/email").toBeVisible();
  // The form is server-rendered and visible about a second before React
  // hydrates it. A click in that window submits it natively as a GET, which
  // reloads the empty form without `next` and never sends a code.
  await page
    .waitForFunction(isFormHydrated, null, { timeout: 30_000 })
    .catch(() => {
      throw new Error("The sign-in form never hydrated");
    });
  await emailField.fill(credentials.email);
  const requestedAt = new Date();
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  const codeField = page.getByLabel("Sign-in code", { exact: true });
  // The form's own error line; Next's route announcer is outside <main>.
  const formError = page.getByRole("main").getByRole("alert");
  await expect(
    codeField.or(formError),
    "after Send code, the Sign-in code field or a form error appears",
  ).toBeVisible();
  if (await formError.isVisible()) {
    const copy = await formError.innerText();
    throw new SignInRefusedError(
      `Cue refused to send a sign-in code: ${copy}`,
      `Refused: Cue would not send a sign-in code and showed "${copy}". It allows 5 code requests a minute per address, so this is a rate limit or a server error; the next hourly run retries.`,
    );
  }
  const code = await waitForSignInCode(credentials, {
    since: requestedAt,
    timeoutMs: SIGN_IN_CODE_TIMEOUT_MS,
  });
  metrics.codeDeliveryMs = Date.now() - requestedAt.getTime();
  if (!code) {
    throw new SignInRefusedError(
      "No sign-in code arrived within the timeout",
      "No sign-in code email arrived. Check that email-code sign-in is on for the QA account (Settings) and that production has RESEND_API_KEY and a verified RESEND_FROM_EMAIL. Cue also answers as if it sent a code when one was sent to the address less than a minute earlier.",
    );
  }
  const submittedAt = Date.now();
  await codeField.fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const settings = page.getByRole("heading", {
    name: "Settings",
    exact: true,
  });
  await expect(
    settings.or(formError),
    "after Sign in, the Settings heading or a form error appears",
  ).toBeVisible({ timeout: 60_000 });
  if (await formError.isVisible()) {
    const copy = await formError.innerText();
    throw new SignInRefusedError(
      `Cue refused the sign-in code: ${copy}`,
      `Refused: Cue rejected the emailed sign-in code and showed "${copy}". Cue caps code sign-in attempts at 20 per address per day; past the cap it refuses even a fresh code until the 24-hour window frees up.`,
    );
  }
  metrics.signInMs = Date.now() - submittedAt;
  rememberAppOrigin(page);
}

/**
 * Fails before Send if the reply is addressed to anyone but the QA account
 * (or, for an Outlook probe's reply, the Gmail QA account it came from).
 */
export async function assertOnlySelfRecipients(
  page: Page,
  allowed: string | readonly string[],
) {
  const own = new Set([allowed].flat());
  const labels = await page
    .getByRole("button", { name: /^Remove .+@/ })
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label") ?? ""),
    );
  const others = labels
    .map((label) =>
      label
        .replace(/^Remove /, "")
        .trim()
        .toLowerCase(),
    )
    .filter((address) => !own.has(address));
  expect(others.length, "the reply is addressed only to the QA account").toBe(
    0,
  );
}

/**
 * While a reply is in flight, aborts any app write whose body names an
 * address other than the QA accounts or the reserved seed domains, so a UI
 * regression can never send mail to a real person.
 */
export async function guardRecipients(
  page: Page,
  allowed: string | readonly string[],
) {
  const own = new Set([allowed].flat());
  const origin = new URL(page.url()).origin;
  const matches = (url: URL) =>
    url.origin === origin && url.pathname.startsWith("/api/");
  const handler = async (route: Route) => {
    const request = route.request();
    const addresses =
      ["POST", "PUT", "PATCH"].includes(request.method()) && request.postData()
        ? (request
            .postData()
            ?.toLowerCase()
            .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [])
        : [];
    const foreign = addresses.some(
      (address) =>
        !own.has(address) &&
        !address.endsWith("@example.com") &&
        !address.endsWith("@cue-qa.invalid"),
    );
    if (foreign) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  };
  // Context-wide, so requests from the mail engine's workers are covered too.
  await page.context().route(matches, handler);
  return () => page.context().unroute(matches, handler);
}

/**
 * Whether the open thread shows `text`. Sent mail is HTML, which the reader
 * renders in a sandboxed frame that page-level text locators do not reach.
 */
export async function threadShowsText(page: Page, text: string) {
  if ((await page.getByTestId("thread-reader").getByText(text).count()) > 0)
    return true;
  const frames = page.locator('iframe[title="Email content preview"]');
  const count = await frames.count();
  for (let index = 0; index < count; index += 1) {
    const frame = frames.nth(index).contentFrame();
    if ((await frame.getByText(text).count()) > 0) return true;
  }
  return false;
}

export async function readSession(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/get-session", {
      credentials: "include",
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body?.session ? "present" : null;
  });
}

/** Ends the session server-side so a leaked trace cannot be replayed. */
export async function revokeSession(page: Page) {
  if (page.isClosed() || !page.url().startsWith("http")) return;
  await page
    .evaluate(() =>
      fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then(() => undefined),
    )
    .catch(() => undefined);
}

/** Runs in the page: React attaches its props to an element when it hydrates. */
function isFormHydrated() {
  const form = document.querySelector("main form");
  return (
    form !== null &&
    Object.keys(form).some((key) => key.startsWith("__reactProps$"))
  );
}
