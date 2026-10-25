import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "../playwright-test";
import { getEmailAccountId } from "../account-test-helpers";
import { insertInboxMailInConversation } from "./mail-test-helpers";
import {
  ARCHIVE_SUBJECT,
  requireElectron,
  startHostedElectron,
  waitForHostedElectronReady,
} from "./hosted-electron-test-helpers";

const THREAD_ID = "thr_playwright_archive";

// Its own spec so it has its own Gmail request quota. Its metadata-coverage
// wait pages through the whole mailbox, and after the other hosted desktop
// proofs have spent the same account's per-minute budget a throttled page
// pauses the background backfill for 30 s or more, which doubled this test's
// run time and sometimes outlasted the ready wait.
requireElectron();

test("returns an archived conversation when new mail arrives through desktop IPC", async ({
  page,
  baseURL,
}, testInfo) => {
  const emailAccountId = await getEmailAccountId(page);
  const authFile = process.env.PLAYWRIGHT_AUTH_FILE;
  if (!baseURL) throw new Error("Playwright baseURL is missing");
  if (!authFile) throw new Error("PLAYWRIGHT_AUTH_FILE is missing");

  const screenshotPath = testInfo.outputPath(
    "hosted-electron-archive-new-mail.png",
  );
  await mkdir(dirname(screenshotPath), { recursive: true });
  const userData = await mkdtemp(
    join(tmpdir(), "electron-hosted-archive-new-mail-"),
  );
  const readyPath = join(userData, "electron-ready");
  const cleanupErrors: unknown[] = [];
  const session = startHostedElectron({
    appUrl: baseURL,
    accountId: emailAccountId,
    storageState: authFile,
    screenshotPath,
    proof: "archive-new-mail",
    userData,
    readyPath,
  });

  try {
    await waitForHostedElectronReady(readyPath, session);
    await insertInboxMailInConversation(page, {
      threadId: THREAD_ID,
      messageId: "msg_playwright_archive",
      subject: ARCHIVE_SUBJECT,
      from: "Erin Example <erin@example.com>",
    });
    const payload = await session.done;
    expect(payload.url).toMatch(/^https?:/);
    expect(payload.url).not.toContain("file:");
    expect(payload.transport).toBe("desktop-ipc");
    expect(payload.sqliteExists).toBe(true);
    expect(payload.proof).toBe("archive-new-mail");
    expect(payload.archiveSucceeded).toBe(true);
    expect(payload.changeRequests).toBeGreaterThan(0);
    expect(payload.enumerationRequests).toBe(0);
    expect(payload.nativeInboxHasArchiveSubject).toBe(true);
    expect(
      payload.subjectsBefore?.some((text) => text.includes(ARCHIVE_SUBJECT)),
    ).toBe(true);
    expect(
      payload.subjectsAfterArchive?.some((text) =>
        text.includes(ARCHIVE_SUBJECT),
      ),
    ).toBe(false);
    expect(
      payload.subjectsAfter?.some((text) => text.includes(ARCHIVE_SUBJECT)),
    ).toBe(true);
    testInfo.annotations.push({
      type: "hosted-electron-payload",
      description: JSON.stringify({
        url: payload.url,
        transport: payload.transport,
        proof: payload.proof,
        archiveSucceeded: payload.archiveSucceeded,
        changeRequests: payload.changeRequests,
        enumerationRequests: payload.enumerationRequests,
        nativeInboxHasArchiveSubject: payload.nativeInboxHasArchiveSubject,
      }),
    });
  } finally {
    await page.request
      .post(`/api/threads/${THREAD_ID}/unarchive`, {
        headers: { "X-Email-Account-ID": emailAccountId },
      })
      .then((response) => expect(response.ok()).toBe(true))
      .catch((error) => {
        cleanupErrors.push(error);
      });
    await session.done.catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
    for (const error of cleanupErrors) {
      testInfo.annotations.push({
        type: "cleanup-error",
        description: String(error),
      });
    }
  }
  expect(cleanupErrors).toEqual([]);
});
