import { expect, type Page } from "@playwright/test";
import { isMicrosoftPlaywright } from "../mail-provider";
import { test } from "../playwright-test";
import {
  grantAiAccess,
  openMail,
  readProviderAccessToken,
} from "./mail-test-helpers";

// The model downloads on first use, so the first search can take a while.
const INDEX_TIMEOUT_MS = 240_000;

let restorePlans: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  if (isMicrosoftPlaywright()) return;
  restorePlans = await grantAiAccess();
});

test.afterAll(async () => {
  await restorePlans?.();
  restorePlans = undefined;
});

test.beforeEach(() => {
  test.skip(
    isMicrosoftPlaywright(),
    "The mail is seeded through the Gmail emulator.",
  );
});

test("finds mail by meaning when its words differ from the search", async ({
  page,
}) => {
  test.setTimeout(INDEX_TIMEOUT_MS + 120_000);
  // The index starts at once and looks for new mail every few seconds.
  await page.addInitScript(() => {
    window.__inboxZeroMailSemanticIndexIntervalMs = 2000;
  });
  // The runtime's wasm is the app's own asset: nothing loads from a CDN.
  const wasm: { url: string; contentType: string | undefined }[] = [];
  page.context().on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith(".wasm"))
      wasm.push({
        url: response.url(),
        contentType: response.headers()["content-type"],
      });
  });
  await page
    .context()
    .route("https://cdn.jsdelivr.net/**", (route) => route.abort());
  const token = randomToken();
  const subject = `Kitchen remodel proposal ${token}`;
  await insertInboxMail(page, {
    from: "Ben Alvarez (Alvarez Remodeling) <ben@remodel.example>",
    subject,
    body: "Hi, attached is the proposal for redoing your kitchen: new cabinets, quartz counters and lighting. Six weeks start to finish.",
  });
  // Cue's reading of the search names words this mail doesn't contain.
  await page.route("**/api/user/search-intent", async (route) => {
    await route.fulfill({
      json: {
        searches: ["invoice contractor"],
        editableSearches: ["invoice contractor"],
        unreadOnly: false,
        explanation: "Invoices from a contractor",
        isQuestion: false,
        timeZone: "UTC",
      },
    });
  });

  const { conversations } = await openMail(page);
  await expect(conversations.getByText(subject, { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  const searchInput = page.getByPlaceholder("Search mail");
  const cueSection = page.getByRole("listbox", { name: "Mail Cue found" });
  const hit = cueSection
    .getByRole("option")
    .filter({ has: page.getByText(subject, { exact: true }) });
  // Searched again until the background index has embedded the new mail.
  await expect(async () => {
    await searchInput.fill("");
    await searchInput.press("Enter");
    await searchInput.fill("the invoice from the contractor about the kitchen");
    await searchInput.press("Enter");
    await expect(cueSection.getByRole("option").first()).toBeVisible({
      timeout: 15_000,
    });
    // Other mail close in meaning may come first.
    const showAll = page.getByRole("button", { name: /^Show all/ });
    if (await showAll.isVisible()) await showAll.click();
    await expect(hit).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: INDEX_TIMEOUT_MS, intervals: [3000] });

  console.log(`wasm loaded: ${JSON.stringify(wasm)}`);
  const appOrigin = new URL(page.url()).origin;
  // With no wasm seen at all, the checks below would pass vacuously.
  expect(wasm.length).toBeGreaterThan(0);
  for (const asset of wasm) {
    expect(new URL(asset.url).origin).toBe(appOrigin);
    expect(asset.contentType).toContain("application/wasm");
  }
});

async function insertInboxMail(
  page: Page,
  input: { from: string; subject: string; body: string },
) {
  const email = process.env.PLAYWRIGHT_TEST_EMAIL;
  const baseUrl = process.env.GOOGLE_BASE_URL;
  if (!email) throw new Error("PLAYWRIGHT_TEST_EMAIL is missing");
  if (!baseUrl) throw new Error("GOOGLE_BASE_URL is missing");
  const inserted = await page.request.post(
    `${baseUrl}/gmail/v1/users/me/messages`,
    {
      headers: {
        Authorization: `Bearer ${await readProviderAccessToken()}`,
        "content-type": "application/json",
      },
      data: {
        from: input.from,
        to: email,
        subject: input.subject,
        body_text: input.body,
        labelIds: ["INBOX"],
        internalDate: String(Date.now()),
      },
    },
  );
  expect(inserted.ok(), await inserted.text()).toBe(true);
}

// Letters only, so the search reads it as one word and never as a number.
function randomToken() {
  return Array.from({ length: 10 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join("");
}
