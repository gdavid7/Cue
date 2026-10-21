import { expect, type Page, test } from "@playwright/test";
import { cueDemoChat } from "@/__tests__/fixtures/inboxes/cue-demo-inbox";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { OUTLOOK_STEP_PREFIX } from "@/scripts/qa/health-report";
import {
  appendInboxMessages,
  pruneReplyProbes,
  QA_PROBE_SUBJECT_PREFIX,
  type QaMailboxCredentials,
  readQaMailboxCredentials,
  readQaOutlookMailbox,
  sendOutlookProbe,
  sendSelfMessage,
  trashMessagesWithSubject,
  waitForMessageFrom,
} from "@/scripts/qa/qa-mailbox";
import { findEscapedMarkup } from "@/utils/email/escaped-markup";
import {
  findMailAccount,
  replyToGmailQa,
  trashOpenThread,
} from "./outlook-probe";
import {
  assertOnlySelfRecipients,
  guardRecipients,
  readSession,
  revokeSession,
  SignInRefusedError,
  signInWithEmailCode,
  threadShowsText,
} from "./qa-session";
import { RobotRun, StepSkippedError } from "./robot-run";

// A synthetic user that walks production as the dedicated QA account. It
// records every step instead of stopping at the first failure; the health
// report turns the results into one machine-readable summary.

const credentials = readQaMailboxCredentials();
const outlookMailbox = credentials
  ? readQaOutlookMailbox(credentials.email)
  : null;
const baseUrl = process.env.CUE_QA_BASE_URL || "https://cue-inbox.vercel.app";
const run = new RobotRun(
  baseUrl,
  process.env.CUE_QA_RESULTS_FILE || ".tmp/qa-robot/results.json",
);
const runId = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
  : String(Date.now());
const PROBE_ARRIVAL_TIMEOUT_MS = 180_000;
// Sends wait out a 30-second undo window before they reach Gmail.
const SENT_TIMEOUT_MS = 150_000;
// Cue gives up on a reply after 15 seconds and says so; this leaves room for
// the thread to open first.
const SUGGESTION_TIMEOUT_MS = 60_000;

if (!credentials) {
  console.log(
    "NOT CONFIGURED: CUE_QA_EMAIL / CUE_QA_IMAP_APP_PASSWORD are not set; skipping the production robot.",
  );
}
test.skip(!credentials, "QA account secrets are not configured");
if (outlookMailbox?.status === "not_configured") {
  console.log(
    "NOT CONFIGURED: CUE_QA_OUTLOOK_EMAIL is not set; skipping the Outlook steps.",
  );
}

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
    try {
      await signInWithEmailCode(page, credentials, metrics);
    } catch (error) {
      if (error instanceof SignInRefusedError) run.signInFailed(error.note);
      throw error;
    }
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

  // One model call per run. The message comes from a reserved example.com
  // sender because Cue never suggests a reply to the user's own mail.
  await step(
    "suggested reply text is clean",
    (metrics) =>
      checkSuggestionText(page, credentials, qaAccount().index, runId, metrics),
    "gmail",
  );

  await step(
    "Today shows its sections",
    (metrics) => checkToday(page, qaAccount().id, metrics),
    "gmail",
  );

  await step(
    "chat answers about seeded mail",
    async (metrics) => {
      const answer = await askChat(
        page,
        qaAccount().id,
        cueDemoChat.question,
        metrics,
      );
      // Informational only: whether the answer used the seeded due date.
      metrics.chatMentionsDueDay = /friday/i.test(answer);
    },
    "gmail",
  );

  if (outlookMailbox?.status === "misconfigured") {
    await run.step(
      `${OUTLOOK_STEP_PREFIX}configuration`,
      { page, testInfo },
      async () => {
        throw new Error(`Outlook misconfigured: ${outlookMailbox.reason}`);
      },
    );
  }

  if (outlookMailbox?.status === "configured") {
    const outlookEmail = outlookMailbox.email;
    let outlook: { id: string; index: number } | null = null;
    const outlookAccount = () => {
      if (!outlook) throw new Error("No Outlook QA mailbox; see its step");
      return outlook;
    };
    const outlookStep = (
      name: string,
      body: (metrics: Record<string, number | boolean>) => Promise<void>,
    ) =>
      run.step(
        `${OUTLOOK_STEP_PREFIX}${name}`,
        { page, testInfo, requires: "outlook" },
        body,
      );

    await outlookStep("mailbox is connected", async () => {
      const found = await findMailAccount(page, outlookEmail);
      if (!found || found.disconnected) {
        const problem = found
          ? "Cue marked the Outlook QA mailbox as disconnected."
          : "the Outlook QA mailbox is not linked to the QA user in Cue.";
        run.outlookUnavailable(problem);
        throw new Error(`Outlook: ${problem}`);
      }
      outlook = found;
    });

    await outlookStep("inbox shows mail", async (metrics) => {
      const started = Date.now();
      await page.goto(`/mail/u/${outlookAccount().index}/inbox`, {
        waitUntil: "commit",
      });
      const conversations = page.getByRole("listbox", {
        name: "Conversations",
      });
      await expect(
        conversations.getByRole("option").first(),
        "an Outlook inbox row appears",
      ).toBeVisible({ timeout: 90_000 });
      metrics.timeToFirstRowMs = Date.now() - started;
      await expect(
        page.getByText(/Reconnect (this|your) account/i),
        "the Outlook mailbox does not ask to reconnect",
      ).toHaveCount(0);
    });

    await outlookStep(
      "probe arrives and the reply reaches Gmail",
      async (metrics) => {
        const subject = `${QA_PROBE_SUBJECT_PREFIX} outlook ${runId}`;
        const token = `Cue QA Outlook reply ${runId}`;
        await sendOutlookProbe(credentials, outlookEmail, {
          subject,
          text: "Automated Cue QA probe. Safe to ignore.",
        });
        const sentAt = Date.now();
        const inboxPath = `/mail/u/${outlookAccount().index}/inbox`;
        await page.goto(inboxPath);
        const probe = page
          .getByRole("listbox", { name: "Conversations" })
          .getByRole("option")
          .filter({ hasText: subject })
          .first();
        await expect(async () => {
          if (!(await probe.isVisible())) await page.reload();
          await expect(probe).toBeVisible({ timeout: 20_000 });
        }, "the probe email reaches the Outlook inbox").toPass({
          timeout: PROBE_ARRIVAL_TIMEOUT_MS,
        });
        metrics.inboundSyncMs = Date.now() - sentAt;

        await probe.click();
        try {
          const clickedAt = new Date();
          await replyToGmailQa(page, {
            gmail: credentials.email,
            outlook: outlookEmail,
            token,
          });
          const received = await waitForMessageFrom(credentials, {
            from: outlookEmail,
            subject,
            token,
            since: clickedAt,
            timeoutMs: SENT_TIMEOUT_MS,
          });
          expect(
            received,
            "the reply reaches the Gmail QA inbox",
          ).not.toBeNull();
          metrics.replyDeliveredMs = Math.max(
            0,
            (received?.getTime() ?? 0) - clickedAt.getTime(),
          );
        } finally {
          // Even after a failed reply, so probes do not pile up in Outlook.
          await trashOpenThread(page, outlookAccount().id).catch(
            () => undefined,
          );
        }
      },
    );

    await outlookStep("Today shows its sections", (metrics) =>
      checkToday(page, outlookAccount().id, metrics),
    );

    await outlookStep("chat answers", async (metrics) => {
      await askChat(
        page,
        outlookAccount().id,
        "What is the most recent email in my inbox about?",
        metrics,
      );
    });
  }

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

async function checkSuggestionText(
  page: Page,
  credentials: QaMailboxCredentials,
  accountIndex: number,
  runId: string,
  metrics: Record<string, number | boolean>,
) {
  const tag = `s${runId.replaceAll(/\D/g, "")}`;
  const subject = `Cue QA suggestion probe ${tag}`;
  // Delivered mail's subject words, for the cleanup search.
  const subjectWords = ["suggestion", "probe", tag];
  metrics.suggestionShown = false;
  try {
    await appendInboxMessages(credentials, [
      {
        subject,
        from: { name: "Jonas Weber", address: "jonas.weber@example.com" },
        text: "Hi,\n\nCan you confirm Q3's numbers & send them over? A quick yes or no on timing is fine.\n\nThanks,\nJonas",
        messageId: `<cue-qa-suggestion-${tag}@cue-qa.invalid>`,
      },
    ]);
    await page.goto(`/mail/u/${accountIndex}/inbox`);
    const probe = page
      .getByRole("listbox", { name: "Conversations" })
      .getByRole("option")
      .filter({ hasText: subject })
      .first();
    await expect(async () => {
      if (!(await probe.isVisible())) await page.reload();
      await expect(probe).toBeVisible({ timeout: 20_000 });
    }, "the suggestion probe reaches the inbox").toPass({
      timeout: PROBE_ARRIVAL_TIMEOUT_MS,
    });
    await probe.click();

    const reader = page.getByTestId("thread-reader");
    const shown = reader.getByText("Suggested by Cue");
    const draftButton = reader.getByRole("button", { name: "Draft a reply" });
    const gaveUp = reader.getByRole("button", { name: "Try again" });
    const left = reader.getByText(/Cue left this reply|Cue couldn't confirm/);
    // Whichever way the account is set up, Cue writes the reply on its own or
    // after "Draft a reply"; it is asked at most once so the run costs one call.
    const deadline = Date.now() + SUGGESTION_TIMEOUT_MS;
    let asked = false;
    while (Date.now() < deadline && !(await shown.isVisible())) {
      if (
        (await gaveUp.isVisible()) ||
        (await left
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        break;
      }
      if (!asked && (await draftButton.isVisible())) {
        asked = true;
        await draftButton.click();
      }
      await page.waitForTimeout(1000);
    }
    if (!(await shown.isVisible())) {
      throw new StepSkippedError("skipped: no suggestion");
    }

    const editor = reader.locator("[data-email-editor-content]").last();
    await expect
      .poll(async () => (await editor.innerText()).trim().length, {
        message: "the suggestion has text",
        timeout: 10_000,
      })
      .toBeGreaterThan(0);
    const text = await editor.innerText();
    metrics.suggestionShown = true;
    metrics.suggestionChars = text.length;
    // Only the kinds are reported: the report is public. The suggestion is
    // never sent or edited, so it leaves nothing in the mailbox.
    const leaks = findEscapedMarkup(text);
    expect(
      leaks,
      `the suggested reply shows escaped HTML (${leaks.join(", ")})`,
    ).toEqual([]);
  } finally {
    await trashMessagesWithSubject(credentials, subjectWords).catch(
      () => undefined,
    );
  }
}

async function checkToday(
  page: Page,
  accountId: string,
  metrics: Record<string, number | boolean>,
) {
  const started = Date.now();
  await page.goto(`/${accountId}/home`);
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
}

/** Asks the account's assistant one question and returns its answer. */
async function askChat(
  page: Page,
  accountId: string,
  question: string,
  metrics: Record<string, number | boolean>,
) {
  await page.goto(`/${accountId}/assistant`);
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
  await input.fill(question);
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
  return answer;
}
