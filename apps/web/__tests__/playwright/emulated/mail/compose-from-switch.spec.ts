import { expect, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import {
  createSecondEmailAccount,
  deleteSecondEmailAccount,
} from "./account-test-helpers";
import {
  openMail,
  readProviderAccessToken,
  withClient,
} from "./mail-test-helpers";

const UPLOAD_TIMEOUT_MS = 90_000;

test("keeps a new message's text, recipients and files when From changes", async ({
  page,
}, testInfo) => {
  test.skip(
    isMicrosoftPlaywright(),
    "Reads the mailbox drafts back from the Gmail emulator.",
  );
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  const primarySignature = "Primary account signature";
  const secondarySignature = "Secondary account signature";
  const previousSignature = await setSignature(
    emailAccountId,
    primarySignature,
  );
  const secondAccount = await createSecondEmailAccount(emailAccountId, {
    signature: secondarySignature,
  });
  const subject = `From switch ${testInfo.retry}-${Date.now()}`;
  const body = "Text written before choosing the account.";
  const file = {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Notes that move with the draft."),
  };

  try {
    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    await page.getByRole("button", { name: /^Compose/ }).click();
    const dialog = page.getByRole("dialog", { name: "New Message" });
    const from = dialog.getByRole("combobox", { name: "From" });
    await expect(from).toBeVisible();
    await dialog
      .getByRole("combobox", { name: "To", exact: true })
      .fill("recipient@example.com");
    await page.keyboard.press("Enter");
    await dialog.getByPlaceholder("Subject").fill(subject);
    const editor = dialog.getByRole("textbox", { name: "Email message" });
    await editor.fill(body);
    await dialog.getByTestId("compose-attachments-input").setInputFiles(file);
    const attachments = dialog.getByRole("list", { name: "Attachments" });
    await expect(attachments).toContainText(file.name);
    await expect(attachments.locator("li[aria-busy]")).toHaveCount(0, {
      timeout: UPLOAD_TIMEOUT_MS,
    });
    await dialog.getByRole("button", { name: "Show signature" }).click();
    const signature = editor.locator("[data-smartmail]");
    await expect(signature).toContainText(primarySignature);
    await expect
      .poll(() => readDraftFiles(page, subject), { timeout: 60_000 })
      .toEqual([[file.name]]);

    await from.click();
    await page
      .getByRole("option", {
        name: `${secondAccount.name} (${secondAccount.email})`,
        exact: true,
      })
      .click();

    await expect(from).toContainText(secondAccount.email);
    // Said only once the new account holds the whole message.
    await expect(
      page.getByText(`Draft moved to ${secondAccount.email}`, { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByPlaceholder("Subject")).toHaveValue(subject);
    await expect(dialog).toContainText("recipient@example.com");
    await expect(editor).toContainText(body);
    await expect(attachments).toContainText(file.name);
    await expect(attachments.locator("li[aria-busy]")).toHaveCount(0, {
      timeout: UPLOAD_TIMEOUT_MS,
    });
    await dialog.getByRole("button", { name: "Show signature" }).click();
    await expect(signature).toContainText(secondarySignature);
    await expect(signature).not.toContainText(primarySignature);
    await capturePlaywrightCheckpoint(page, testInfo, "compose-from-switched");

    // Both accounts read one emulated mailbox, so exactly one draft must
    // remain: the old account's is removed and the new one holds the file.
    await expect
      .poll(() => readDraftFiles(page, subject), { timeout: 60_000 })
      .toEqual([[file.name]]);

    await dialog.getByRole("button", { name: "Discard draft" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
    await setSignature(emailAccountId, previousSignature);
  }
});

// The old account's drafts are the only copy until the new account holds the
// message, so an account that can't load hands the message back intact.
test("returns the message to its account when the new From can't load", async ({
  page,
}) => {
  test.skip(
    isMicrosoftPlaywright(),
    "Reads the mailbox drafts back from the Gmail emulator.",
  );
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  const secondAccount = await createSecondEmailAccount(emailAccountId);
  const subject = `From switch failure ${Date.now()}`;
  const body = "Text that must survive a failed switch.";

  try {
    await page.route("**/api/user/email-account", async (route) => {
      const accountId = await route.request().headerValue("x-email-account-id");
      if (accountId !== secondAccount.id) return route.fallback();
      await route.fulfill({
        status: 500,
        json: { error: "Playwright: this account is unavailable." },
      });
    });
    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    await page.getByRole("button", { name: /^Compose/ }).click();
    const dialog = page.getByRole("dialog", { name: "New Message" });
    const from = dialog.getByRole("combobox", { name: "From" });
    await dialog
      .getByRole("combobox", { name: "To", exact: true })
      .fill("recipient@example.com");
    await page.keyboard.press("Enter");
    await dialog.getByPlaceholder("Subject").fill(subject);
    const editor = dialog.getByRole("textbox", { name: "Email message" });
    await editor.fill(body);
    await expect
      .poll(() => readDraftFiles(page, subject), { timeout: 60_000 })
      .toEqual([[]]);

    await from.click();
    await page
      .getByRole("option", {
        name: `${secondAccount.name} (${secondAccount.email})`,
        exact: true,
      })
      .click();

    await expect(
      page.getByText("Playwright: this account is unavailable."),
    ).toBeVisible({ timeout: 60_000 });
    await expect(from).not.toContainText(secondAccount.email, {
      timeout: 30_000,
    });
    await expect(dialog.getByPlaceholder("Subject")).toHaveValue(subject);
    await expect(dialog).toContainText("recipient@example.com");
    await expect(editor).toContainText(body);
    await expect(page.getByText(/^Draft moved to /)).toHaveCount(0);
    // The old account's mailbox draft was never removed.
    expect(await readDraftFiles(page, subject)).toEqual([[]]);

    await dialog.getByRole("button", { name: "Discard draft" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
  }
});

// A copy on this device can be lost with the tab, so the old mailbox draft
// stays until the new account's mailbox has the message.
test("keeps the old mailbox draft while the new mailbox can't save it", async ({
  page,
}) => {
  test.skip(
    isMicrosoftPlaywright(),
    "Reads the mailbox drafts back from the Gmail emulator.",
  );
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  const secondAccount = await createSecondEmailAccount(emailAccountId);
  const subject = `From switch unsaved ${Date.now()}`;

  try {
    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    await page.getByRole("button", { name: /^Compose/ }).click();
    const dialog = page.getByRole("dialog", { name: "New Message" });
    const from = dialog.getByRole("combobox", { name: "From" });
    await dialog
      .getByRole("combobox", { name: "To", exact: true })
      .fill("recipient@example.com");
    await page.keyboard.press("Enter");
    await dialog.getByPlaceholder("Subject").fill(subject);
    await dialog
      .getByRole("textbox", { name: "Email message" })
      .fill("Only the old mailbox has this.");
    await expect
      .poll(() => readDraftFiles(page, subject), { timeout: 60_000 })
      .toEqual([[]]);

    // Every mailbox save from here on fails.
    let refusedSaves = 0;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        !(await request.headerValue("next-action"))
      )
        return route.fallback();
      refusedSaves += 1;
      await route.fulfill({ status: 500, body: "" });
    });
    await from.click();
    await page
      .getByRole("option", {
        name: `${secondAccount.name} (${secondAccount.email})`,
        exact: true,
      })
      .click();
    await expect(from).toContainText(secondAccount.email, { timeout: 60_000 });
    await expect
      .poll(() => refusedSaves, { timeout: 30_000 })
      .toBeGreaterThan(0);

    await expect(page.getByText(/^Draft moved to /)).toHaveCount(0);
    expect(await readDraftFiles(page, subject)).toEqual([[]]);
    await page.unroute("**/*");
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
  }
});

test("keeps text typed while the message moves to another From", async ({
  page,
}) => {
  test.skip(
    isMicrosoftPlaywright(),
    "Reads the mailbox drafts back from the Gmail emulator.",
  );
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  const secondAccount = await createSecondEmailAccount(emailAccountId);
  const subject = `From switch typing ${Date.now()}`;

  try {
    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    await page.getByRole("button", { name: /^Compose/ }).click();
    const dialog = page.getByRole("dialog", { name: "New Message" });
    const from = dialog.getByRole("combobox", { name: "From" });
    await dialog
      .getByRole("combobox", { name: "To", exact: true })
      .fill("recipient@example.com");
    await page.keyboard.press("Enter");
    await dialog.getByPlaceholder("Subject").fill(subject);
    const editor = dialog.getByRole("textbox", { name: "Email message" });
    await editor.fill("Before the switch.");
    await expect
      .poll(() => readDraftFiles(page, subject), { timeout: 60_000 })
      .toEqual([[]]);

    // Hold the next mailbox save, so the move waits on it while typing goes on.
    let releaseSave = () => {};
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let saveStarted = false;
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        !(await request.headerValue("next-action"))
      )
        return route.fallback();
      saveStarted = true;
      await saveHeld;
      await route.fallback();
    });
    await editor.press("End");
    await editor.pressSequentially(" More.");
    await expect.poll(() => saveStarted, { timeout: 30_000 }).toBe(true);

    await from.click();
    await page
      .getByRole("option", {
        name: `${secondAccount.name} (${secondAccount.email})`,
        exact: true,
      })
      .click();
    // While the move waits, the message can't be edited.
    const form = dialog.locator("form");
    await expect(form).toHaveAttribute("inert", "");
    // Clicks and keys can't reach an inert editor, so nothing can be typed.
    expect(
      await editor.evaluate((element) => Boolean(element.closest("[inert]"))),
    ).toBe(true);
    releaseSave();

    await expect(from).toContainText(secondAccount.email, { timeout: 60_000 });
    await expect(editor).toContainText("Before the switch. More.");
    await expect(form).not.toHaveAttribute("inert");
    await page.unroute("**/*");
    await dialog.getByRole("button", { name: "Discard draft" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
  }
});

test("says which files stay behind when the message moves", async ({
  page,
}) => {
  test.skip(
    isMicrosoftPlaywright(),
    "Reads the mailbox drafts back from the Gmail emulator.",
  );
  test.setTimeout(240_000);
  const { emailAccountId } = await openMail(page);
  const secondAccount = await createSecondEmailAccount(emailAccountId);
  const subject = `From switch failed file ${Date.now()}`;

  try {
    await page.route("**/api/user/drafts/*/attachments?*", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 500,
            json: { error: "Playwright: upload refused." },
          })
        : route.fallback(),
    );
    await page.goto(`/${emailAccountId}/mail?accountScope=all`);
    await page.getByRole("button", { name: /^Compose/ }).click();
    const dialog = page.getByRole("dialog", { name: "New Message" });
    await dialog
      .getByRole("combobox", { name: "To", exact: true })
      .fill("recipient@example.com");
    await page.keyboard.press("Enter");
    await dialog.getByPlaceholder("Subject").fill(subject);
    await dialog
      .getByRole("textbox", { name: "Email message" })
      .fill("The file did not upload.");
    await dialog.getByTestId("compose-attachments-input").setInputFiles({
      name: "left-behind.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("never uploaded"),
    });
    await expect(page.getByText("Playwright: upload refused.")).toBeVisible({
      timeout: 60_000,
    });

    await dialog.getByRole("combobox", { name: "From" }).click();
    await page
      .getByRole("option", {
        name: `${secondAccount.name} (${secondAccount.email})`,
        exact: true,
      })
      .click();

    await expect(
      page.getByText("Could not attach left-behind.txt.", { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByRole("combobox", { name: "From" })).toContainText(
      secondAccount.email,
      { timeout: 60_000 },
    );
    await expect(dialog.getByRole("list", { name: "Attachments" })).toHaveCount(
      0,
    );
    await dialog.getByRole("button", { name: "Discard draft" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await deleteSecondEmailAccount(secondAccount.accountId);
  }
});

async function setSignature(emailAccountId: string, signature: string | null) {
  return withClient(async (client) => {
    const previous = await client.query<{ signature: string | null }>(
      `SELECT signature FROM "EmailAccount" WHERE id = $1`,
      [emailAccountId],
    );
    await client.query(
      `UPDATE "EmailAccount" SET signature = $1 WHERE id = $2`,
      [signature, emailAccountId],
    );
    return previous.rows[0]?.signature ?? null;
  });
}

/** The file names on each mailbox draft with this subject. */
async function readDraftFiles(page: Page, subject: string) {
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const headers = {
    Authorization: `Bearer ${await readProviderAccessToken()}`,
  };
  const listed = await page.request.get(
    `${baseUrl}/gmail/v1/users/me/messages?labelIds=DRAFT&maxResults=500`,
    { headers },
  );
  expect(listed.ok(), await listed.text()).toBe(true);
  const { messages = [] } = (await listed.json()) as {
    messages?: { id: string }[];
  };
  const drafts: string[][] = [];
  for (const { id } of messages) {
    const response = await page.request.get(
      `${baseUrl}/gmail/v1/users/me/messages/${id}?format=full`,
      { headers },
    );
    if (!response.ok()) continue;
    const message = (await response.json()) as { payload?: GmailPart };
    const messageSubject = message.payload?.headers?.find(
      (header) => header.name.toLowerCase() === "subject",
    )?.value;
    if (messageSubject === subject)
      drafts.push(listFileNames(message.payload).sort());
  }
  return drafts;
}

type GmailPart = {
  filename?: string;
  headers?: { name: string; value: string }[];
  parts?: GmailPart[];
};

function listFileNames(part: GmailPart | undefined): string[] {
  if (!part) return [];
  return [
    ...(part.filename ? [part.filename] : []),
    ...(part.parts ?? []).flatMap(listFileNames),
  ];
}
