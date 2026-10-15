import { expect, type Page, type Route, test } from "@playwright/test";
import { cueDemoChat } from "@/__tests__/fixtures/inboxes/cue-demo-inbox";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import {
  pruneReplyProbes,
  QA_PROBE_SUBJECT_PREFIX,
  readQaMailboxCredentials,
  sendSelfMessage,
  waitForSignInCode,
} from "@/scripts/qa/qa-mailbox";
import { RobotRun } from "./robot-run";

// A synthetic user that walks production as the dedicated QA account. It
// records every step instead of stopping at the first failure; the health
// report turns the results into one machine-readable summary.

const credentials = readQaMailboxCredentials();
const baseUrl = process.env.CUE_QA_BASE_URL || "https://cue-inbox.vercel.app";
const run = new RobotRun(
  baseUrl,
  process.env.CUE_QA_RESULTS_FILE || ".tmp/qa-robot/results.json",
);
const runId = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : String(Date.now());
const SIGN_IN_CODE_TIMEOUT_MS = 150_000;
const PROBE_ARRIVAL_TIMEOUT_MS = 180_000;
// Sends wait out a 30-second undo window before they reach Gmail.
const SENT_TIMEOUT_MS = 150_000;

if (!credentials) {
  console.log(
    "NOT CONFIGURED: CUE_QA_EMAIL / CUE_QA_IMAP_APP_PASSWORD are not set; skipping the production robot.",
  );
}
test.skip(!credentials, "QA account secrets are not configured");

test.afterEach(async ({ page }) => {
  if (run.status !== "sign_in_failed") await revokeSession(page);
  await run.write();
});

test("production smoke as the QA account", async ({ page }, testInfo) => {
  if (!credentials) return;
  run.attach(page);
  const step = (
    name: string,
    body: (metrics: Record<string, number | boolean>) => Promise<void>,
    requires: "session" | "gmail" = "session",
  ) => run.step(name, { page, testInfo, requires }, body);
  let account: { id: string; index: number } | null = null;
  const qaAccount = () => {
    if (!account) throw new Error("No QA mail account; see the gmail step");
    return account;
  };

  const signIn = { page, testInfo, describePageOnFailure: true };
  await run.step("sign in with email code", signIn, async (metrics) => {
    await page.goto("/login/email?next=%2Fsettings", {
      waitUntil: "domcontentloaded",
    });
    const emailField = page.getByLabel("Email", { exact: true });
    await expect(
      emailField,
      "the Email field is on /login/email",
    ).toBeVisible();
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
      run.signInFailed(
        `Refused: Cue would not send a sign-in code and showed "${copy}". It allows 5 code requests a minute per address, so this is a rate limit or a server error; the next hourly run retries.`,
      );
      throw new Error(`Cue refused to send a sign-in code: ${copy}`);
    }
    const code = await waitForSignInCode(credentials, {
      since: requestedAt,
      timeoutMs: SIGN_IN_CODE_TIMEOUT_MS,
    });
    metrics.codeDeliveryMs = Date.now() - requestedAt.getTime();
    if (!code) {
      run.signInFailed(
        "No sign-in code email arrived. Check that email-code sign-in is on for the QA account (Settings) and that production has RESEND_API_KEY and a verified RESEND_FROM_EMAIL. Cue also answers as if it sent a code when one was sent to the address less than a minute earlier.",
      );
      throw new Error("No sign-in code arrived within the timeout");
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
      run.signInFailed(
        `Refused: Cue rejected the emailed sign-in code and showed "${copy}". Cue caps code sign-in attempts at 20 per address per day; past the cap it refuses even a fresh code until the 24-hour window frees up.`,
      );
      throw new Error(`Cue refused the sign-in code: ${copy}`);
    }
    metrics.signInMs = Date.now() - submittedAt;
  });
  if (run.status === "failed") {
    const error = run.steps.at(-1)?.error;
    run.signInFailed(
      `Signing in with the email code failed${error ? `: ${error}` : "."}`,
    );
  }

  await step("gmail connection", async (metrics) => {
    const response = await page.request.get("/api/user/email-accounts");
    expect(response.ok(), "email accounts load").toBe(true);
    const { emailAccounts }: GetEmailAccountsResponse = await response.json();
    const index = emailAccounts.findIndex(
      (emailAccount) =>
        emailAccount.email.toLowerCase() === credentials.email.toLowerCase(),
    );
    const match = emailAccounts[index];
    if (!match) throw new Error("The QA mailbox is not connected to Cue");
    account = { id: match.id, index };
    metrics.providerRateLimited = Boolean(match.providerRateLimit);
    if (match.account.disconnectedAt) {
      run.needsReconnect(
        "Cue marked the QA account's Gmail connection as disconnected.",
      );
    }
  });

  await step(
    "inbox shows real mail",
    async (metrics) => {
      const started = Date.now();
      await page.goto(`/mail/u/${qaAccount().index}/inbox`, {
        waitUntil: "commit",
      });
      const conversations = page.getByRole("listbox", {
        name: "Conversations",
      });
      const reconnect = page.getByText(/Reconnect (this|your) account/i);
      await expect(
        conversations.getByRole("option").first().or(reconnect.first()),
        "an inbox row appears",
      ).toBeVisible({ timeout: 90_000 });
      if (await reconnect.first().isVisible()) {
        run.needsReconnect("The inbox asks to reconnect the QA account.");
        return;
      }
      metrics.timeToFirstRowMs = Date.now() - started;
      metrics.inboxRows = await conversations.getByRole("option").count();
      await expect(
        page.getByText(/Gmail is (rate )?limiting/i),
        "no Gmail rate-limit banner",
      ).toHaveCount(0);
      await expect(
        page.getByText("Waiting to sync", { exact: false }),
        "no Waiting to sync status",
      ).toHaveCount(0);
    },
    "gmail",
  );

  await step(
    "thread shows reply actions",
    async () => {
      await page.goto(`/mail/u/${qaAccount().index}/inbox`);
      // A seeded announcement sent to a class list, so Reply all applies.
      const row = page
        .getByRole("listbox", { name: "Conversations" })
        .getByRole("option")
        .filter({ hasText: "milestone 2 due Friday" })
        .first();
      await expect(
        row,
        "the seeded multi-recipient thread is in the inbox (run the seed workflow if not)",
      ).toBeVisible({ timeout: 60_000 });
      await row.click();
      const message = page.locator("[data-thread-message-id]").last();
      await expect(message, "the thread opens").toBeVisible({
        timeout: 60_000,
      });
      for (const name of ["Reply", "Reply all", "Forward"]) {
        await expect(
          message.getByRole("button", { name, exact: true }),
          `${name} is visible`,
        ).toBeVisible();
      }
    },
    "gmail",
  );

  await step(
    "reply to self lands in Sent",
    async (metrics) => {
      const subject = `${QA_PROBE_SUBJECT_PREFIX} ${runId}`;
      const token = `Cue QA reply ${runId}`;
      await sendSelfMessage(credentials, {
        subject,
        text: "Automated Cue QA probe. Safe to ignore.",
      });
      const sentAt = Date.now();
      await page.goto(`/mail/u/${qaAccount().index}/inbox`);
      const conversations = page.getByRole("listbox", {
        name: "Conversations",
      });
      const probe = conversations
        .getByRole("option")
        .filter({ hasText: subject })
        .first();
      await expect(async () => {
        if (!(await probe.isVisible())) await page.reload();
        await expect(probe).toBeVisible({ timeout: 20_000 });
      }, "the probe email reaches the inbox").toPass({
        timeout: PROBE_ARRIVAL_TIMEOUT_MS,
      });
      metrics.inboundSyncMs = Date.now() - sentAt;

      await probe.click();
      const message = page.locator("[data-thread-message-id]").last();
      await message.getByRole("button", { name: "Reply", exact: true }).click();
      const editor = message.getByRole("textbox", { name: "Email message" });
      await expect(editor).toBeVisible();
      await assertOnlySelfRecipients(page, credentials.email);
      await editor.pressSequentially(token);
      const releaseGuard = await guardRecipients(page, credentials.email);
      try {
        const clickedAt = Date.now();
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(editor, "the composer closes after Send").toHaveCount(0);
        // The send leaves the browser only after its undo window, so stay in
        // the app until then rather than navigating away mid-send.
        await expect(
          page.getByText("Sending…", { exact: true }),
          "the send leaves the undo window",
        ).toHaveCount(0, { timeout: 90_000 });
        await page.getByRole("link", { name: /^Sent/ }).first().click();
        const sentRow = page
          .getByRole("listbox", { name: "Conversations" })
          .getByRole("option")
          .filter({ hasText: subject })
          .first();
        await expect(async () => {
          // An opened thread replaces the list, so reloading it would never
          // bring the row back; go back to the Sent list instead.
          if (!(await sentRow.isVisible())) {
            await page.goto(`/mail/u/${qaAccount().index}/sent`);
          }
          await sentRow.click({ timeout: 10_000 });
          await expect
            .poll(() => threadShowsText(page, token), { timeout: 15_000 })
            .toBe(true);
        }, "the reply appears in Sent").toPass({ timeout: SENT_TIMEOUT_MS });
        metrics.replyToSentMs = Date.now() - clickedAt;
      } finally {
        await releaseGuard();
      }
      await pruneReplyProbes(credentials, 3).catch(() => undefined);
    },
    "gmail",
  );

  await step(
    "Today shows its sections",
    async (metrics) => {
      const started = Date.now();
      await page.goto(`/${qaAccount().id}/home`);
      const lane = page.getByRole("heading", {
        level: 2,
        name: /Needs reply|Waiting on|Next up|All clear|Also in your inbox|Drafts ready for you|Cue is working on/,
      });
      // Today often shows both, such as a notice above "Also in your inbox".
      await expect(
        lane.or(page.getByRole("main").getByRole("status")).first(),
        "Today shows a lane or a status line",
      ).toBeVisible({ timeout: 60_000 });
      metrics.todayLoadMs = Date.now() - started;
      metrics.todaySections = await lane.count();
      await expect(page.getByText("Something went wrong")).toHaveCount(0);
    },
    "gmail",
  );

  await step(
    "chat answers about seeded mail",
    async (metrics) => {
      await page.goto(`/${qaAccount().id}/assistant`);
      const input = page.getByTestId("chat-input");
      await expect(input).toBeVisible({ timeout: 60_000 });
      const answers = page.locator(".is-assistant");
      // With an empty input the submit button is enabled only while an
      // answer is being generated (it doubles as Stop).
      const submit = page
        .locator("form")
        .filter({ has: input })
        .locator('button[type="submit"]');
      const before = await answers.count();
      const started = Date.now();
      await input.fill(cueDemoChat.question);
      await input.press("Enter");
      const failure = page.getByText("We couldn't send your message");
      await expect(
        answers.nth(before).or(failure).first(),
        "the answer starts",
      ).toBeVisible({ timeout: 60_000 });
      await expect(submit, "the answer finishes").toBeDisabled({
        timeout: 180_000,
      });
      await expect(failure, "the chat request succeeds").toHaveCount(0);
      const answer = (await answers.nth(before).innerText()).trim();
      expect(answer.length, "the answer has text").toBeGreaterThan(0);
      metrics.chatAnswerMs = Date.now() - started;
      metrics.chatAnswerChars = answer.length;
      // Informational only: whether the answer used the seeded due date.
      metrics.chatMentionsDueDay = /friday/i.test(answer);
    },
    "gmail",
  );

  await step("Settings opens", async () => {
    await page.goto("/settings");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
  });

  await step("Integrations is available", async () => {
    await page.goto(`/${qaAccount().id}/integrations`);
    await expect(
      page.getByRole("heading", { name: "Integrations", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText("limited rollout", { exact: false }),
      "Integrations is not gated behind the limited rollout",
    ).toHaveCount(0);
  });

  await step("Rules opens", async () => {
    await page.goto(`/${qaAccount().id}/automation`);
    await expect(
      page.getByRole("heading", { name: "Rules", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
  });

  await step("old mail URL redirects", async () => {
    await page.goto(`/${qaAccount().id}/mail`);
    await expect(page).toHaveURL(/\/mail\/u\/\d+\/inbox/, { timeout: 60_000 });
  });

  await step("sign out in one click", async (metrics) => {
    await page.goto("/settings");
    const signOut = page.getByRole("button", { name: "Sign out", exact: true });
    await expect(signOut).toBeVisible({ timeout: 60_000 });
    const started = Date.now();
    await signOut.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/settings"), {
      timeout: 60_000,
    });
    metrics.signOutMs = Date.now() - started;
    expect(await readSession(page), "the session is gone").toBeNull();
  });

  const failed = run.failedSteps.map((s) => s.name);
  expect(failed, "every robot step passed").toEqual([]);
});

/** Fails before Send if the reply is addressed to anyone but the QA account. */
async function assertOnlySelfRecipients(page: Page, self: string) {
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
    .filter((address) => address !== self);
  expect(others.length, "the reply is addressed only to the QA account").toBe(
    0,
  );
}

/**
 * While a reply is in flight, aborts any app write whose body names an
 * address other than the QA account or the reserved seed domains, so a UI
 * regression can never send mail to a real person.
 */
async function guardRecipients(page: Page, self: string) {
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
        address !== self &&
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
async function threadShowsText(page: Page, text: string) {
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

async function readSession(page: Page) {
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
async function revokeSession(page: Page) {
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
