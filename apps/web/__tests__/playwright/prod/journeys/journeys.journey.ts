import { expect, type Page, test } from "@playwright/test";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import {
  buildGroundTruth,
  type GroundTruth,
  journeySubject,
  matchFacts,
  parseUiMessageStream,
} from "@/scripts/qa/journey-ground-truth";
import {
  parseJourneySelection,
  resolveBudgets,
} from "@/scripts/qa/journey-report";
import { readQaMailboxCredentials } from "@/scripts/qa/qa-mailbox";
import { buildMailPath } from "@/utils/mail-url";
import {
  armInteraction,
  editorReady,
  firstInboxRowVisible,
  readerShowsText,
  timeSinceInput,
} from "../../emulated/mail/perf-test-helpers";
import {
  guardRecipients,
  revokeSession,
  SignInRefusedError,
  signInWithEmailCode,
} from "../qa-session";
import { createEmulatorJourneyMailbox } from "./emulated-mailbox";
import { type AttemptContext, JourneyRun } from "./journey-run";
import {
  createImapJourneyMailbox,
  type DeliveryMethod,
  type JourneyMailbox,
} from "./journey-mailbox";
import {
  installJourneyProbes,
  onlyRowsMatching,
  readProbes,
  rowWithSubjectAbsent,
  rowWithSubjectPresent,
  rowWithSubjectShown,
} from "./page-probes";

// The journeys robot: walks the flows people use all day as the QA account,
// times each against a budget and checks what it can know for certain (mail it
// delivered shows up; the chat answers with facts only the planted mail
// holds). It runs on its own every few hours and on demand with a subset of
// journeys. See README.md next to this file's parent for setup and triggers.

// Journeys must finish by then; cleanup and the results file get the rest of
// the config's 15-minute global timeout.
const RUN_BUDGET_MS = 12.5 * 60_000;
// Long enough to put a number on a multi-minute delay, short enough to leave
// time for the rest of the run.
const NEW_MAIL_OPEN_WAIT_MS = 180_000;
const NEW_MAIL_ON_OPEN_WAIT_MS = 60_000;
const SEND_TO_INBOX_WAIT_MS = 150_000;
const CHAT_ANSWER_WAIT_MS = 150_000;
const ESTIMATE_MS = {
  "inbox-load": 60_000,
  "new-mail": NEW_MAIL_OPEN_WAIT_MS + NEW_MAIL_ON_OPEN_WAIT_MS + 30_000,
  chat: 4 * 50_000,
  triage: 90_000,
  search: 45_000,
  "compose-send": SEND_TO_INBOX_WAIT_MS + 20_000,
} as const;

const selected = parseJourneySelection(process.env.CUE_JOURNEYS);
const budgets = resolveBudgets(process.env.CUE_JOURNEY_BUDGETS);

test("Cue journeys", async ({ page }, testInfo) => {
  test.setTimeout(RUN_BUDGET_MS + 2 * 60_000);
  const emulated = testInfo.project.name === "journeys-emulated";
  const baseUrl = String(testInfo.project.use.baseURL ?? "");
  const runTag = makeRunTag();
  const run = new JourneyRun({
    mode: emulated ? "emulated" : "production",
    baseUrl,
    runTag,
    resultsFile:
      process.env.CUE_JOURNEYS_RESULTS_FILE || ".tmp/journeys/results.json",
    selected,
    budgets,
    deadline: Date.now() + RUN_BUDGET_MS,
  });
  const credentials = emulated ? null : readQaMailboxCredentials();
  if (!emulated && !credentials) {
    console.log(
      "NOT CONFIGURED: CUE_QA_EMAIL / CUE_QA_IMAP_APP_PASSWORD are not set; skipping the journeys robot.",
    );
    run.outcome = "not_configured";
    await run.write();
    test.skip(true, "QA account secrets are not configured");
    return;
  }
  const mailbox: JourneyMailbox = credentials
    ? createImapJourneyMailbox(credentials)
    : createEmulatorJourneyMailbox();
  const truth = buildGroundTruth({ runTag });
  let signedIn = false;

  try {
    // Leftovers from a run that crashed before cleaning up.
    run.cleanup.removed += await mailbox.removeJourneyMail().catch((error) => {
      run.cleanup.error = `stale mail: ${describe(error)}`;
      return 0;
    });
    if (selected.some((name) => ["chat", "triage", "search"].includes(name))) {
      // Planted first, so Gmail has indexed them by the time they are used.
      await mailbox
        .deliver(runTag, truth.emails, mailbox.deliveryMethods[0])
        .catch((error) => {
          run.note = `Planting the chat, triage and search mail failed: ${describe(error)}`;
        });
    }

    await page.addInitScript(installJourneyProbes);
    run.attach(page);

    if (credentials) {
      const signIn: Record<string, number | boolean> = {};
      try {
        await signInWithEmailCode(page, credentials, signIn);
        signedIn = true;
      } catch (error) {
        run.outcome = "sign_in_failed";
        run.note =
          error instanceof SignInRefusedError
            ? error.note
            : `Signing in with the email code failed: ${describe(error)}`;
      }
    }

    const account =
      run.outcome === "completed"
        ? await findAccount(page, mailbox.self).catch((error) => {
            run.outcome = "needs_reconnect";
            run.note = describe(error);
            return null;
          })
        : null;
    if (account?.disconnected) {
      run.outcome = "needs_reconnect";
      run.note =
        "Cue marked the QA account's Gmail connection as disconnected.";
    }
    const inboxPath = buildMailPath({ accountIndex: account?.index ?? 0 });
    const options = (name: keyof typeof ESTIMATE_MS) => ({
      page,
      testInfo,
      estimateMs: ESTIMATE_MS[name],
    });

    await run.run("inbox-load", options("inbox-load"), (attempt) =>
      inboxLoad(page, inboxPath, attempt, () => {
        run.outcome = "needs_reconnect";
        run.note = "The inbox asks to reconnect the QA account.";
      }),
    );
    await run.run("new-mail", options("new-mail"), (attempt) =>
      newMail(page, { inboxPath, mailbox, runTag, attempt }),
    );
    await run.run("chat", options("chat"), (attempt) =>
      chat(page, { accountId: account?.id ?? "", mailbox, truth, attempt }),
    );
    await run.run("triage", options("triage"), (attempt) =>
      triage(page, { inboxPath, truth, attempt }),
    );
    await run.run("search", options("search"), (attempt) =>
      search(page, { inboxPath, truth, attempt }),
    );
    await run.run("compose-send", options("compose-send"), (attempt) =>
      composeSend(page, { inboxPath, mailbox, runTag, attempt }),
    );
  } finally {
    try {
      run.cleanup.removed += await mailbox.removeJourneyMail(runTag);
    } catch (error) {
      run.cleanup.error = describe(error);
    }
    if (signedIn) await revokeSession(page);
    await run.write();
  }

  expect(run.failedJourneys, "no journey failed").toEqual([]);
});

async function inboxLoad(
  page: Page,
  inboxPath: string,
  { metrics, check }: AttemptContext,
  onReconnect: () => void,
) {
  await page.goto("about:blank");
  await page.goto(inboxPath, { waitUntil: "commit" });
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  const reconnect = page.getByText(/Reconnect (this|your) account/i).first();
  const firstRow = page
    .waitForFunction(firstInboxRowVisible, undefined, {
      polling: "raf",
      timeout: 45_000,
    })
    .then((handle) => handle.jsonValue() as Promise<number>)
    .catch(() => null);
  const reconnectShown = reconnect
    .waitFor({ timeout: 45_000 })
    .then(() => "reconnect" as const)
    .catch(() => null);
  const shown = await Promise.race([firstRow, reconnectShown]);
  if (shown === "reconnect") {
    onReconnect();
    throw new Error("The inbox asks to reconnect the QA account");
  }
  const rowAt = shown ?? (await firstRow);
  if (rowAt === null) throw new Error("No inbox row within 45s");
  metrics.firstRowMs = rowAt;
  metrics.inboxRows = await conversations.getByRole("option").count();
  check(
    "no Gmail rate-limit banner",
    (await page.getByText(/Gmail is (rate )?limiting/i).count()) === 0,
  );
  check(
    "no Waiting to sync status",
    (await page.getByText("Waiting to sync", { exact: false }).count()) === 0,
  );
  await page.waitForTimeout(2000);
  metrics.clsX1000 = Math.round((await readProbes(page)).cls * 1000);
}

/**
 * Mail delivered while the inbox is open must appear without a reload, and
 * mail delivered while the app is closed must be there when it opens. Each
 * delivery method is timed separately; the mail stream's change events say
 * whether a slow arrival waited on the server's push or on the browser.
 */
async function newMail(
  page: Page,
  {
    inboxPath,
    mailbox,
    runTag,
    attempt: { attempt, metrics, check, remainingMs },
  }: {
    inboxPath: string;
    mailbox: JourneyMailbox;
    runTag: string;
    attempt: AttemptContext;
  },
) {
  await openInbox(page, inboxPath);
  // Let the mail stream connect, as it would for someone who just opened Cue.
  await page.waitForTimeout(3000);
  const probesBefore = await readProbes(page);
  metrics.mailStreamConnected = probesBefore.mailEvents.some(
    (event) => event.type === "ready",
  );

  const deliveries = mailbox.deliveryMethods.map((method) => ({
    method,
    message: {
      key: `new-${method}-${attempt}`,
      subject: journeySubject(`Arrival check ${method} ${attempt}`, runTag),
      from: { name: "Cue QA arrivals", address: "arrivals@example.com" },
      text: "Automated Cue QA message to time new mail. Safe to ignore.",
    },
  }));
  const deliveredAt = new Map<DeliveryMethod, number>();
  await Promise.all(
    deliveries.map(async ({ method, message }) => {
      await mailbox.deliver(runTag, [message], method);
      deliveredAt.set(method, Date.now());
    }),
  );
  await mailbox.notifyApp(page);

  const wait = Math.min(NEW_MAIL_OPEN_WAIT_MS, remainingMs() - 90_000);
  const arrivals = await Promise.all(
    deliveries.map(({ message }) =>
      page
        .waitForFunction(
          rowWithSubjectShown,
          { subject: message.subject, wallClock: true },
          { polling: 250, timeout: Math.max(wait, 10_000) },
        )
        .then((handle) => handle.jsonValue() as Promise<number>)
        .catch(() => null),
    ),
  );
  for (const [index, { method }] of deliveries.entries()) {
    const shownAt = arrivals[index];
    const sentAt = deliveredAt.get(method) ?? Date.now();
    metrics[`newMailWhileOpenMs:${method}`] = shownAt
      ? Math.max(0, shownAt - sentAt)
      : Date.now() - sentAt;
    check(
      `${method} delivery shows while the inbox is open`,
      shownAt !== null,
      shownAt
        ? undefined
        : `not shown after ${Math.round((Date.now() - sentAt) / 1000)}s without a reload`,
    );
  }
  const firstDelivery = Math.min(...deliveredAt.values());
  const changes = (await readProbes(page)).mailEvents.filter(
    (event) => event.type === "mailbox-change" && event.at >= firstDelivery,
  );
  metrics.pushEvents = changes.length;
  if (changes[0]) metrics.pushEventMs = changes[0].at - firstDelivery;

  // The app is closed while the next message arrives, then opened.
  await page.goto("about:blank");
  const closedMessage = {
    key: `new-closed-${attempt}`,
    subject: journeySubject(`Arrival check closed ${attempt}`, runTag),
    from: { name: "Cue QA arrivals", address: "arrivals@example.com" },
    text: "Automated Cue QA message to time mail that arrived while Cue was closed.",
  };
  await mailbox.deliver(runTag, [closedMessage], mailbox.deliveryMethods[0]);
  await page.waitForTimeout(mailbox.settleMs);
  await page.goto(inboxPath, { waitUntil: "commit" });
  const shown = await page
    .waitForFunction(
      rowWithSubjectShown,
      { subject: closedMessage.subject, wallClock: false },
      { polling: "raf", timeout: NEW_MAIL_ON_OPEN_WAIT_MS },
    )
    .then((handle) => handle.jsonValue() as Promise<number>)
    .catch(() => null);
  metrics.newMailOnOpenMs = shown ?? NEW_MAIL_ON_OPEN_WAIT_MS;
  check(
    "mail delivered while closed shows on open",
    shown !== null,
    shown
      ? undefined
      : `not shown ${NEW_MAIL_ON_OPEN_WAIT_MS / 1000}s after opening`,
  );
  metrics.clsX1000 = Math.round((await readProbes(page)).cls * 1000);
}

/**
 * Asks questions whose answers only the planted mail holds, each in a new
 * chat, and grades every answer by its facts. The answer, its timing and its
 * tool calls are read from the chat's own response stream.
 */
async function chat(
  page: Page,
  {
    accountId,
    mailbox,
    truth,
    attempt: { attempt, metrics, check, remainingMs },
  }: {
    accountId: string;
    mailbox: JourneyMailbox;
    truth: GroundTruth;
    attempt: AttemptContext;
  },
) {
  const answers: Record<string, unknown>[] = [];
  try {
    for (const question of truth.questions) {
      if (remainingMs() < 60_000) {
        check(`chat ${question.id} asked`, false, "no time left in the run");
        continue;
      }
      if (mailbox.prepareChatAnswer) {
        await mailbox.prepareChatAnswer(
          question.question,
          question.facts.map((fact) => fact.anyOf[0]).join("; "),
        );
      }
      await page.goto(`/${accountId}/assistant`);
      const input = page.getByTestId("chat-input");
      await expect(input).toBeVisible({ timeout: 60_000 });
      const answersShown = page.locator(".is-assistant");
      const submit = page
        .locator("form")
        .filter({ has: input })
        .locator('button[type="submit"]');
      const failure = page.getByText("We couldn't send your message");
      const before = await answersShown.count();
      const streamsBefore = (await readProbes(page)).chat.length;
      await input.fill(question.question);
      await armInteraction(page);
      await input.press("Enter");
      await expect(
        answersShown.nth(before).or(failure).first(),
        "the answer starts",
      ).toBeVisible({ timeout: 60_000 });
      // With an empty input the submit button is enabled only while an
      // answer is being generated (it doubles as Stop).
      const finished = await expect(submit)
        .toBeDisabled({ timeout: Math.min(CHAT_ANSWER_WAIT_MS, remainingMs()) })
        .then(() => true)
        .catch(() => false);
      const sentAt = await page.evaluate(
        () => (window as unknown as { __perfT0?: number }).__perfT0 ?? 0,
      );
      const streams = (await readProbes(page)).chat.slice(streamsBefore);
      const stream = parseUiMessageStream(streams.map((s) => s.raw).join("\n"));
      const firstText = streams.find(
        (s) => s.firstTextAt !== null,
      )?.firstTextAt;
      const ended = streams.at(-1)?.endedAt;
      const answer =
        stream.text.trim() ||
        (await answersShown
          .nth(before)
          .innerText()
          .catch(() => ""));

      if (firstText)
        metrics[`chatFirstTokenMs:${question.id}`] = firstText - sentAt;
      metrics[`chatTotalMs:${question.id}`] = ended
        ? ended - sentAt
        : await page
            .evaluate(() => performance.now())
            .then((now) => now - sentAt);
      metrics[`chatToolCalls:${question.id}`] = stream.toolCalls.length;

      const graded = matchFacts(answer, question.facts);
      check(
        `chat ${question.id} answer has the planted facts`,
        graded.missing.length === 0,
        graded.missing.length
          ? `missing ${graded.missing.join(", ")}`
          : undefined,
      );
      check(
        `chat ${question.id} completes`,
        finished && (await failure.count()) === 0 && streams.length > 0,
        !streams.length
          ? "no chat response stream"
          : !finished
            ? "still answering at the time limit"
            : "the chat showed an error",
      );
      check(
        `chat ${question.id} tools succeed`,
        stream.toolErrors.length === 0 && stream.streamErrors === 0,
        [
          ...stream.toolErrors.map((error) => `${error.tool} ${error.kind}`),
          ...(stream.streamErrors
            ? [`${stream.streamErrors} stream errors`]
            : []),
        ].join(", ") || undefined,
      );
      answers.push({
        attempt,
        id: question.id,
        question: question.question,
        answer,
        tools: stream.toolCalls,
        toolErrors: stream.toolErrors,
        missing: graded.missing,
        missingOptional: graded.missingOptional,
      });
    }
  } finally {
    // The QA inbox only holds synthetic mail, so the answers are safe to keep
    // in the run's artifact for diagnosing a wrong one.
    await test.info().attach(`chat-answers-attempt-${attempt}.json`, {
      body: JSON.stringify(answers, null, 2),
      contentType: "application/json",
    });
  }
}

/** Opens planted mail, archives it, and undoes the archive. */
async function triage(
  page: Page,
  {
    inboxPath,
    truth,
    attempt: { metrics, check },
  }: { inboxPath: string; truth: GroundTruth; attempt: AttemptContext },
) {
  await openInbox(page, inboxPath);
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  const row = conversations
    .getByRole("option")
    .filter({ hasText: truth.triageSubject })
    .first();
  await expect(row, "the planted message is in the inbox").toBeVisible({
    timeout: 60_000,
  });

  await armInteraction(page);
  await row.click();
  metrics.openEmailMs = await timeSinceInput(
    page,
    readerShowsText,
    truth.triageBodyText,
    20_000,
  );
  await page.keyboard.press("Escape");
  await expect(row).toBeVisible({ timeout: 20_000 });

  await row.getByRole("checkbox", { includeHidden: true }).click();
  await armInteraction(page);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  metrics.archiveMs = await timeSinceInput(
    page,
    rowWithSubjectAbsent,
    truth.triageSubject,
    10_000,
  );

  const undo = page
    .getByRole("region", { name: "Notifications alt+T" })
    .getByRole("button", { name: /^Undo/ });
  await armInteraction(page);
  if (await undo.isVisible()) await undo.click();
  else await page.keyboard.press("z");
  metrics.undoMs = await timeSinceInput(
    page,
    rowWithSubjectPresent,
    truth.triageSubject,
    15_000,
  );
  // An undo that only restores the row on screen would let it vanish again.
  await page.waitForTimeout(3000);
  check(
    "the restored message stays in the inbox",
    (await page.evaluate(rowWithSubjectPresent, truth.triageSubject)) !== false,
  );
}

async function search(
  page: Page,
  {
    inboxPath,
    truth,
    attempt: { metrics },
  }: { inboxPath: string; truth: GroundTruth; attempt: AttemptContext },
) {
  await openInbox(page, inboxPath);
  const box = page.getByPlaceholder("Search mail");
  await box.fill(truth.searchTerm);
  await armInteraction(page);
  await box.press("Enter");
  // The planted invoice is in the inbox already, so the results count only
  // once the list holds nothing else.
  metrics.searchMs = await timeSinceInput(
    page,
    onlyRowsMatching,
    truth.searchTerm,
    30_000,
  );
  await page.getByRole("button", { name: "Clear search" }).click();
}

/**
 * Composes a message to the QA account itself and follows it out of the
 * undo-send window and back into the mailbox, with every app write that
 * names another address blocked.
 */
async function composeSend(
  page: Page,
  {
    inboxPath,
    mailbox,
    runTag,
    attempt: { attempt, metrics, remainingMs },
  }: {
    inboxPath: string;
    mailbox: JourneyMailbox;
    runTag: string;
    attempt: AttemptContext;
  },
) {
  await openInbox(page, inboxPath);
  const subject = journeySubject(`Compose check ${attempt}`, runTag);
  const releaseGuard = await guardRecipients(page, mailbox.self);
  try {
    await armInteraction(page);
    await page.getByRole("button", { name: /^Compose/ }).click();
    metrics.composeOpenMs = await timeSinceInput(
      page,
      editorReady,
      undefined,
      15_000,
    );
    const dialog = page.getByRole("dialog", { name: "New Message" });
    const to = dialog.getByRole("combobox", { name: "To" });
    await to.fill(mailbox.self);
    await dialog.getByPlaceholder("Subject").fill(subject);
    await dialog
      .locator("[contenteditable='true']")
      .pressSequentially("Automated Cue QA compose check. Safe to ignore.");
    const sentAt = Date.now();
    await dialog.getByRole("button", { exact: true, name: "Send" }).click();
    await expect(dialog, "the composer closes after Send").toBeHidden();
    // Stay in the app until the send leaves its undo window.
    await expect(
      page.getByText("Sending…", { exact: true }),
      "the send leaves the undo window",
    ).toHaveCount(0, { timeout: 90_000 });
    metrics.sendLeftUndoMs = Date.now() - sentAt;
    const view = mailbox.selfSendReachesInbox ? "Inbox" : "Sent";
    await page
      .getByRole("link", { name: new RegExp(`^${view}`) })
      .first()
      .click();
    const shownAt = await page
      .waitForFunction(
        rowWithSubjectShown,
        { subject, wallClock: true },
        {
          polling: 500,
          timeout: Math.max(
            10_000,
            Math.min(SEND_TO_INBOX_WAIT_MS, remainingMs() - 30_000),
          ),
        },
      )
      .then((handle) => handle.jsonValue() as Promise<number>);
    metrics.sendToInboxMs = shownAt - sentAt;
  } finally {
    await releaseGuard();
  }
}

async function openInbox(page: Page, inboxPath: string) {
  const conversations = page.getByRole("listbox", { name: "Conversations" });
  if (!new URL(page.url(), "http://x").pathname.startsWith(inboxPath)) {
    await page.goto(inboxPath, { waitUntil: "commit" });
  }
  await expect(
    conversations.getByRole("option").first(),
    "the inbox shows its rows",
  ).toBeVisible({ timeout: 45_000 });
}

async function findAccount(page: Page, email: string) {
  const response = await page.request.get("/api/user/email-accounts");
  if (!response.ok()) {
    throw new Error(`Email accounts failed to load (${response.status()})`);
  }
  const { emailAccounts }: GetEmailAccountsResponse = await response.json();
  const index = emailAccounts.findIndex(
    (account) => account.email.toLowerCase() === email.toLowerCase(),
  );
  const match = emailAccounts[index];
  if (!match) throw new Error("The QA mailbox is not connected to Cue");
  return {
    id: match.id,
    index,
    disconnected: Boolean(match.account.disconnectedAt),
  };
}

function describe(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).split(
    "\n",
  )[0];
}

/** Letters and digits only: it is a search word in the run's subjects. */
function makeRunTag() {
  const id = process.env.GITHUB_RUN_ID;
  return id
    ? `r${id}a${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
    : `l${Date.now().toString(36)}`;
}
