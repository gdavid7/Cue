import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openMail } from "./mail-test-helpers";

test("suggests contacts in every recipient field and reuses cached searches", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.NEXT_PUBLIC_CONTACTS_ENABLED === "false",
    "API contacts are disabled for this run",
  );
  const queries: string[] = [];
  let releaseSearch: () => void = () => {};
  const pendingSearch = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  await page.route("**/api/user/contacts?*", async (route) => {
    const query =
      new URL(route.request().url()).searchParams.get("query") ?? "";
    queries.push(query);
    if (query === "unmatched") await pendingSearch;
    await route.fulfill({
      json: {
        contacts:
          query === "contact"
            ? [
                { name: "First Contact", emailAddress: "first@example.com" },
                { name: "Second Contact", emailAddress: "second@example.com" },
              ]
            : [],
      },
    });
  });
  await openMail(page);
  await page.getByRole("button", { name: /^Compose/ }).click();
  const dialog = page.getByRole("dialog", { name: "New Message" });
  const to = dialog.getByRole("combobox", { name: "To", exact: true });
  await to.fill("contact");
  await expect(
    page.getByRole("option", { name: "First Contact" }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(page, testInfo, "contact-suggestions");
  await to.press("ArrowDown");
  await to.press("ArrowUp");
  await to.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Remove first@example.com" }),
  ).toBeVisible();
  await expect(to).toHaveValue("");

  await to.fill("contact");
  await expect(
    page.getByRole("option", { name: "Second Contact" }),
  ).toBeVisible();
  await expect(page.getByRole("option", { name: "First Contact" })).toHaveCount(
    0,
  );
  const unmatchedRequest = page.waitForRequest((request) =>
    request.url().includes("/api/user/contacts?query=unmatched"),
  );
  await to.fill("unmatched");
  await unmatchedRequest;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(
    page.getByRole("option", { name: "Second Contact" }),
  ).toHaveCount(0);
  releaseSearch();
  await to.fill("");

  for (const name of ["Cc", "Bcc"]) {
    await dialog
      .getByRole("button", { name: `Add ${name} recipients`, exact: true })
      .click();
    const field = dialog.getByRole("combobox", { name, exact: true });
    await field.fill("contact");
    await page.getByRole("option", { name: "Second Contact" }).click();
    await expect(field).toHaveValue("");
  }
  expect(queries.filter((query) => query === "contact")).toHaveLength(1);

  const bcc = dialog.getByRole("combobox", { name: "Bcc", exact: true });
  await bcc.fill("manual@example.com");
  await bcc.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Remove manual@example.com" }),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`suggests cached mail contacts and selects them in ${theme} mode`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    let apiRequests = 0;
    await page.route("**/api/user/contacts?*", async (route) => {
      apiRequests++;
      await route.fulfill({ json: { contacts: [] } });
    });
    await openMail(page);
    await page.getByRole("button", { name: /^Compose/ }).click();
    const dialog = page.getByRole("dialog", { name: "New Message" });
    const to = dialog.getByRole("combobox", { name: "To", exact: true });
    await to.fill("ali");
    const alice = page.getByRole("option", {
      name: /Alice Example.*alice@example.com/,
    });
    await expect(alice).toBeVisible();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      `${theme}-local-suggestions`,
    );
    const shotDirectory = process.env.CONTACT_SUGGESTIONS_SCREENSHOT_DIR;
    if (shotDirectory) {
      await mkdir(shotDirectory, { recursive: true });
      await page.screenshot({
        path: join(shotDirectory, `${theme}-1-suggestions.png`),
      });
    }
    await to.press("ArrowDown");
    await to.press("Enter");
    await expect(
      dialog.getByRole("button", { name: "Remove alice@example.com" }),
    ).toBeVisible();
    await expect(to).toHaveValue("");
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      `${theme}-local-selected`,
    );
    if (shotDirectory)
      await page.screenshot({
        path: join(shotDirectory, `${theme}-2-selected.png`),
      });
    for (const name of ["Cc", "Bcc"]) {
      await dialog
        .getByRole("button", { name: `Add ${name} recipients`, exact: true })
        .click();
      const field = dialog.getByRole("combobox", { name, exact: true });
      await field.fill("bob");
      await page
        .getByRole("option", { name: /Bob Example.*bob@example.com/ })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Remove bob@example.com" }),
      ).toHaveCount(name === "Cc" ? 1 : 2);
    }
    await to.fill('"Doe, Jamie" <jamie@example.com>, sam@example.com');
    await to.press("Enter");
    await expect(
      dialog.getByRole("button", {
        name: 'Remove "Doe, Jamie" <jamie@example.com>',
      }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Remove sam@example.com" }),
    ).toBeVisible();
    await capturePlaywrightCheckpoint(
      page,
      testInfo,
      "pasted-recipients-selected",
    );
    if (process.env.NEXT_PUBLIC_CONTACTS_ENABLED === "false")
      expect(apiRequests).toBe(0);
  });
}

test("suggests recipients from mail in a second tab and picks them with Enter or Tab", async ({
  page,
}, testInfo) => {
  // Only the local index answers: production runs with the contacts API off.
  await page
    .context()
    .route("**/api/user/contacts?*", (route) =>
      route.fulfill({ json: { contacts: [] } }),
    );
  await openMail(page);
  await expect
    .poll(async () => page.evaluate(() => window.__inboxZeroMailInspect?.role))
    .toBe("owner");

  const follower = await page.context().newPage();
  await follower.goto(page.url(), { waitUntil: "domcontentloaded" });
  await expect(
    follower.getByRole("listbox", { name: "Conversations" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      async () => follower.evaluate(() => window.__inboxZeroMailInspect?.role),
      { timeout: 60_000 },
    )
    .toBe("follower");

  await follower.getByRole("button", { name: /^Compose/ }).click();
  const dialog = follower.getByRole("dialog", { name: "New Message" });
  const to = dialog.getByRole("combobox", { name: "To", exact: true });
  await to.fill("ali");
  await expect(
    follower.getByRole("option", { name: /Alice Example.*alice@example.com/ }),
  ).toBeVisible();
  await capturePlaywrightCheckpoint(
    follower,
    testInfo,
    "follower-tab-suggestions",
  );
  // The top suggestion is already highlighted, as in Gmail.
  await to.press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Remove alice@example.com" }),
  ).toBeVisible();
  await expect(to).toHaveValue("");

  await to.fill("bob");
  await expect(
    follower.getByRole("option", { name: /Bob Example.*bob@example.com/ }),
  ).toBeVisible();
  await to.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Remove bob@example.com" }),
  ).toBeVisible();
  await expect(to).toHaveValue("");
  await capturePlaywrightCheckpoint(follower, testInfo, "follower-tab-picked");
  await follower.close();
});

test("blocks a send while a recipient field holds half-typed text", async ({
  page,
}, testInfo) => {
  await page.route("**/api/user/contacts?*", (route) =>
    route.fulfill({ json: { contacts: [] } }),
  );
  await openMail(page);
  await page.getByRole("button", { name: /^Compose/ }).click();
  const dialog = page.getByRole("dialog", { name: "New Message" });
  const to = dialog.getByRole("combobox", { name: "To", exact: true });
  await to.fill("alice@example.com");
  await to.press(",");
  await expect(
    dialog.getByRole("button", { name: "Remove alice@example.com" }),
  ).toBeVisible();
  await to.fill("bob@exmaple");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    page.getByText("Enter a valid recipient email address."),
  ).toBeVisible();
  await expect(to).toBeFocused();
  await expect(to).toHaveAttribute("aria-invalid", "true");
  await expect(to).toHaveValue("bob@exmaple");
  await expect(dialog).toBeVisible();
  await capturePlaywrightCheckpoint(
    page,
    testInfo,
    "invalid-recipient-blocked",
  );
});
