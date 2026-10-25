import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "../playwright-test";

export const ARCHIVE_SUBJECT = "Archive Action Message";
export const HIDDEN_SUBJECT = "Keyboard Navigation Message";
const electronBin = getElectronBinary();
const runner = join(
  process.cwd(),
  "../desktop/__tests__/mail-engine/run-hosted-electron-mail.mjs",
);

/** Skips a hosted Electron spec where Electron isn't installed, unless CI requires it. */
export function requireElectron() {
  if (process.env.MAIL_REQUIRE_ELECTRON === "1" && !existsSync(electronBin)) {
    throw new Error("Required Electron runtime is not installed");
  }
  test.skip(!existsSync(electronBin), "Electron binary is not installed");
}

export function launchHostedElectron(input: {
  appUrl: string;
  accountId: string;
  storageState: string;
  screenshotPath: string;
  searchScreenshotPath?: string;
  proof?:
    | "search-archive"
    | "compose"
    | "reconnect"
    | "discard"
    | "send"
    | "star"
    | "assistant-baseline"
    | "assistant-reopen"
    | "missed-hint"
    | "cursor-reset"
    | "bulk"
    | "queued-restart"
    | "inbox-counts"
    | "sign-out"
    | "archive-new-mail";
  draftSubject?: string;
  discardSubject?: string;
  sendSubject?: string;
  starSubject?: string;
  userData?: string;
  readyPath?: string;
}) {
  return startHostedElectron(input).done;
}

export function startHostedElectron(
  input: Parameters<typeof launchHostedElectron>[0],
) {
  let stdout = "";
  let stderr = "";
  const done = new Promise<HostedElectronPayload>((resolve, reject) => {
    const child = spawn("node", [runner], {
      cwd: join(process.cwd(), "../desktop"),
      env: {
        ...process.env,
        ELECTRON_APP_URL: input.appUrl,
        ELECTRON_ACCOUNT_ID: input.accountId,
        ELECTRON_STORAGE_STATE: input.storageState,
        ELECTRON_SCREENSHOT_PATH: input.screenshotPath,
        ...(input.searchScreenshotPath
          ? { ELECTRON_SEARCH_SCREENSHOT_PATH: input.searchScreenshotPath }
          : {}),
        ELECTRON_ARCHIVE_SUBJECT: ARCHIVE_SUBJECT,
        ELECTRON_SEARCH_HIDDEN: HIDDEN_SUBJECT,
        ...(input.proof ? { ELECTRON_PROOF: input.proof } : {}),
        ...(input.draftSubject
          ? { ELECTRON_DRAFT_SUBJECT: input.draftSubject }
          : {}),
        ...(input.discardSubject
          ? { ELECTRON_DISCARD_SUBJECT: input.discardSubject }
          : {}),
        ...(input.sendSubject
          ? { ELECTRON_SEND_SUBJECT: input.sendSubject }
          : {}),
        ...(input.starSubject
          ? { ELECTRON_STAR_SUBJECT: input.starSubject }
          : {}),
        ...(input.userData ? { ELECTRON_USER_DATA: input.userData } : {}),
        ...(input.readyPath ? { ELECTRON_READY_PATH: input.readyPath } : {}),
      },
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `hosted electron runner exited ${code}\n${stdout}\n${stderr}`,
          ),
        );
        return;
      }
      const line = stdout
        .split("\n")
        .find((item) => item.startsWith("ELECTRON_HOSTED_MAIL "));
      try {
        resolve(
          JSON.parse(line?.slice("ELECTRON_HOSTED_MAIL ".length) ?? "{}"),
        );
      } catch (error) {
        reject(
          new Error(
            `hosted electron payload was not JSON\n${stdout}\n${String(error)}`,
          ),
        );
      }
    });
  });
  return { done, output: () => `${stdout}\n${stderr}` };
}

export async function waitForHostedElectronReady(
  readyPath: string,
  session: ReturnType<typeof startHostedElectron>,
) {
  const ready = (async () => {
    // A proof can write ready only after a whole flow (load, full metadata
    // coverage, an archive), which sometimes takes about a minute on CI.
    // This stays under the runner's own 180 s limit.
    for (let attempt = 0; attempt < 480; attempt += 1) {
      if (existsSync(readyPath)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `hosted electron never wrote ${readyPath}\n${session.output()}`,
    );
  })();
  const winner = await Promise.race([
    ready.then(() => "ready" as const),
    session.done.then((payload) => payload),
  ]);
  if (winner === "ready") return;
  throw new Error(
    `hosted electron exited before ready: ${JSON.stringify(winner)}`,
  );
}

type HostedElectronPayload = {
  url?: string;
  transport?: string | null;
  sqliteExists?: boolean;
  proof?: string;
  subjectsBefore?: string[];
  subjectsSearched?: string[];
  searchHidHiddenSubject?: boolean;
  subjectsAfter?: string[];
  nativeInboxHasArchiveSubject?: boolean;
  draftSubjects?: string[];
  nativeDraftHasSubject?: boolean;
  connection?: string | null;
  changeRequests?: number;
  enumerationRequests?: number;
  reconnectUrl?: string;
  headingVisible?: boolean;
  discardSubject?: string;
  sendSubject?: string;
  discardedDraftSubjects?: string[];
  nativeDraftHadDiscardSubject?: boolean;
  nativeDraftHasDiscardSubject?: boolean;
  sendSucceeded?: boolean;
  nativeDraftHasSendSubject?: boolean;
  nativeSentHasSendSubject?: boolean;
  sentSubjects?: string[];
  starSubject?: string;
  readerStarred?: boolean;
  starSucceeded?: boolean;
  nativeStarredHasSubject?: boolean;
  assistantCursor?: string | null;
  assistantStateRequests?: number;
  bootstrapRequests?: number;
  resetFired?: boolean;
  bulkArchived?: boolean;
  bulkUndone?: boolean;
  trashRestored?: boolean;
  labelSucceeded?: boolean;
  nativeInboxHasBulkSubjects?: boolean;
  nativeTrashHasDeleteSubject?: boolean;
  heldOperations?: number;
  queuedBeforeReload?: string;
  queuedAfterReload?: string;
  succeededAfterRelease?: boolean;
  hiddenAfterReload?: boolean;
  inboxUnreadBefore?: number;
  inboxUnreadAfterArchive?: number;
  inboxUnreadAfterRestore?: number;
  unreadHiddenAfterArchive?: boolean;
  unreadVisibleAfterRestore?: boolean;
  sqliteExistsBefore?: boolean;
  sqliteExistsAfter?: boolean;
  sqliteWalExistsAfter?: boolean;
  sqliteShmExistsAfter?: boolean;
  sqliteWalExists?: boolean;
  sqliteShmExists?: boolean;
  signedOut?: boolean;
  subjectsAfterArchive?: string[];
  archiveSucceeded?: boolean;
};

function getElectronBinary(): string {
  try {
    const desktopRequire = createRequire(
      join(process.cwd(), "../desktop/package.json"),
    );
    return desktopRequire("electron") as string;
  } catch (error) {
    if (process.env.MAIL_REQUIRE_ELECTRON === "1") throw error;
    return "";
  }
}
