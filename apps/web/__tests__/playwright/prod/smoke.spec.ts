import { expect, test } from "@playwright/test";
import { cueDemoChat } from "@/__tests__/fixtures/inboxes/cue-demo-inbox";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import {
  pruneReplyProbes,
  QA_PROBE_SUBJECT_PREFIX,
  readQaMailboxCredentials,
  sendSelfMessage,
} from "@/scripts/qa/qa-mailbox";
import {
  assertOnlySelfRecipients,
  guardRecipients,
  readSession,
  revokeSession,
  SignInRefusedError,
  signInWithEmailCode,
  threadShowsText,
} from "./qa-session";
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
