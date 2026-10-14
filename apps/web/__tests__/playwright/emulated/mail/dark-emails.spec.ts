import {
  expect,
  type FrameLocator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { openMail } from "./mail-test-helpers";

// The reader's dark card tone, #2D2F34.
const DARK_SURFACE = "rgb(45, 47, 52)";
const WHITE = "rgb(255, 255, 255)";
const LOGO_BACKING = "rgb(241, 242, 244)";
const FIXTURES = {
  newsletter: {
    threadId: "thr_playwright_dark_newsletter",
    subject: "Field Notes Issue 42",
    text: "Five trails nobody talks about",
  },
  followup: {
    threadId: "thr_playwright_dark_followup",
    subject: "Field Notes Mailbag",
    text: "Your questions about the quiet trails, answered.",
  },
  receipt: {
    threadId: "thr_playwright_dark_receipt",
    subject: "Lumen Coffee Receipt",
    text: "Thanks for your order",
  },
  authored: {
    threadId: "thr_playwright_dark_authored",
    subject: "Aurora October Recap",
    text: "You logged 31 clear nights",
  },
  plain: {
    threadId: "thr_playwright_theme_system",
    subject: "System Theme Message",
    text: "A simple message in the system theme.",
  },
};

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
});

test("adapts a white newsletter and remembers Show original for its sender", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const frame = await openThread(page, emailAccountId, {
    threadId: "thr_playwright_dark_newsletter",
    subject: "Field Notes Issue 42",
    text: "Five trails nobody talks about",
  });

  await expect(frame.locator("html")).toHaveCSS(
    "background-color",
    DARK_SURFACE,
  );
  const heading = frame.getByRole("heading", {
    name: "Five trails nobody talks about",
  });
  await expect(heading).not.toHaveCSS("color", "rgb(17, 17, 17)");
  // Brand colors, pictures and text over a background image stay as sent.
  await expect(frame.getByText("Issue 42 · The quiet trails")).toHaveCSS(
    "background-color",
    "rgb(255, 90, 31)",
  );
  await expect(
    frame.getByRole("link", { name: "Open the trail map" }),
  ).toHaveCSS("background-color", "rgb(26, 115, 232)");
  await expect(
    frame.getByRole("img", { name: "Mountain trail at dawn" }),
  ).not.toHaveAttribute("style", /background|color/);
  await expect(frame.getByRole("img", { name: "Field Notes" })).toHaveCSS(
    "background-color",
    LOGO_BACKING,
  );
  await expect(frame.getByText("Member pick:")).toHaveCSS("color", WHITE);
  for (const name of ["Read the full guide", "Unsubscribe"]) {
    expect(await contrastAgainstBackdrop(frame, name)).toBeGreaterThanOrEqual(
      4.5,
    );
  }
  await captureReader(page, testInfo, "dark-newsletter-adapted");

  await page.getByRole("button", { name: "Show original" }).click();
  const original = emailFrame(page);
  await expect(original.locator("html")).toHaveCSS("background-color", WHITE);
  await expect(
    original.getByRole("heading", { name: "Five trails nobody talks about" }),
  ).toHaveCSS("color", "rgb(17, 17, 17)");
  await expect(
    page.getByRole("button", { name: "Adapt to dark mode" }),
  ).toBeVisible();
  await captureReader(page, testInfo, "dark-newsletter-original");

  // The choice belongs to the sender, so their next email opens the same way.
  const followup = await openThread(page, emailAccountId, {
    threadId: "thr_playwright_dark_followup",
    subject: "Field Notes Mailbag",
    text: "Your questions about the quiet trails, answered.",
  });
  await expect(followup.locator("body")).toHaveCSS("background-color", WHITE);

  // Another sender keeps the default.
  const receipt = await openThread(page, emailAccountId, {
    threadId: "thr_playwright_dark_receipt",
    subject: "Lumen Coffee Receipt",
    text: "Thanks for your order",
  });
  await expect(receipt.locator("html")).toHaveCSS(
    "background-color",
    DARK_SURFACE,
  );
});

test("adapts a receipt and puts its dark logo on a light backing", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const frame = await openThread(page, emailAccountId, {
    threadId: "thr_playwright_dark_receipt",
    subject: "Lumen Coffee Receipt",
    text: "Thanks for your order",
  });

  // The wordmark is dark artwork on a transparent background.
  await expect(frame.getByRole("img", { name: "Lumen Coffee" })).toHaveCSS(
    "background-color",
    LOGO_BACKING,
  );
  await expect(frame.getByText("Flat white, oat")).toHaveCSS(
    "color",
    "rgb(233, 234, 236)",
  );
  expect(
    await contrastAgainstBackdrop(frame, "View receipt online"),
  ).toBeGreaterThanOrEqual(4.5);
  await captureReader(page, testInfo, "dark-receipt-adapted");

  await page.getByRole("button", { name: "Show original" }).click();
  await expect(emailFrame(page).locator("table").first()).toHaveCSS(
    "background-color",
    WHITE,
  );
  await captureReader(page, testInfo, "dark-receipt-original");
});

test("uses the sender's own dark palette when the email has one", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const frame = await openThread(page, emailAccountId, {
    threadId: "thr_playwright_dark_authored",
    subject: "Aurora October Recap",
    text: "You logged 31 clear nights",
  });

  await expect(frame.getByText("You logged 31 clear nights")).toHaveCSS(
    "background-color",
    "rgb(30, 24, 64)",
  );
  await expect(frame.locator("body")).toHaveCSS(
    "background-color",
    "rgb(15, 10, 31)",
  );
  await captureReader(page, testInfo, "dark-authored-adapted");

  await page.getByRole("button", { name: "Show original" }).click();
  await expect(
    emailFrame(page).getByText("You logged 31 clear nights"),
  ).toHaveCSS("background-color", "rgb(245, 243, 255)");
  await captureReader(page, testInfo, "dark-authored-original");
});

test("keeps plain emails on the app theme without a Show original button", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  const frame = await openThread(page, emailAccountId, {
    threadId: "thr_playwright_theme_system",
    subject: "System Theme Message",
    text: "A simple message in the system theme.",
  });

  await expect(frame.locator("body")).toHaveCSS("color-scheme", "dark");
  await expect(page.getByRole("button", { name: "Show original" })).toHaveCount(
    0,
  );
  await captureReader(page, testInfo, "dark-plain");
});

test("shows designed emails as sent when Appearance says so", async ({
  page,
}, testInfo) => {
  const { emailAccountId } = await openMail(page);
  await openAppearanceMenu(page);
  const showOriginal = page.getByRole("menuitemradio", {
    name: "Show original",
  });
  await showOriginal.click();
  // Choosing closes the menu; reopen it to see the choice held.
  await openAppearanceMenu(page);
  await expect(showOriginal).toHaveAttribute("aria-checked", "true");
  await capturePlaywrightCheckpoint(page, testInfo, "dark-appearance-menu");
  await page.keyboard.press("Escape");

  const frame = await openThread(page, emailAccountId, {
    threadId: "thr_playwright_dark_newsletter",
    subject: "Field Notes Issue 42",
    text: "Five trails nobody talks about",
  });
  await expect(frame.locator("html")).toHaveCSS("background-color", WHITE);

  // A sender can still be adapted on its own.
  await page.getByRole("button", { name: "Adapt to dark mode" }).click();
  await expect(emailFrame(page).locator("html")).toHaveCSS(
    "background-color",
    DARK_SURFACE,
  );

  await page.goto("/settings");
  const setting = page.getByRole("combobox", { name: "Emails in dark mode" });
  await expect(setting).toHaveText("Show original", { timeout: 60_000 });
  await setting.scrollIntoViewIfNeeded();
  await capturePlaywrightCheckpoint(page, testInfo, "dark-appearance-settings");
});

test("keeps every recolored text node at AA contrast", async ({ page }) => {
  const { emailAccountId } = await openMail(page);

  for (const fixture of [
    FIXTURES.newsletter,
    FIXTURES.followup,
    FIXTURES.receipt,
  ]) {
    const adapted = await lowContrastText(
      await openThread(page, emailAccountId, fixture),
    );
    await page.getByRole("button", { name: "Show original" }).click();
    await expect(emailFrame(page).locator("html")).toHaveCSS(
      "background-color",
      WHITE,
    );
    const original = await textBackgrounds(emailFrame(page));
    await page.getByRole("button", { name: "Adapt to dark mode" }).click();
    await expect(emailFrame(page).locator("html")).toHaveCSS(
      "background-color",
      DARK_SURFACE,
    );

    // Anything still below AA sits on a fill the sender chose and the
    // adaptation kept, such as white text on a brand banner.
    const recolored = adapted.filter(
      ({ text, background }) => original[text] !== background,
    );
    expect(recolored, fixture.subject).toEqual([]);
  }

  for (const fixture of [FIXTURES.authored, FIXTURES.plain]) {
    expect(
      await lowContrastText(await openThread(page, emailAccountId, fixture)),
      fixture.subject,
    ).toEqual([]);
  }
});

async function openAppearanceMenu(page: Page) {
  await page
    .getByRole("button", { name: /^Account and settings/ })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Appearance" }).click();
}

/** The reader as a whole, and the whole email even where it runs below the fold. */
async function captureReader(page: Page, testInfo: TestInfo, name: string) {
  await capturePlaywrightCheckpoint(page, testInfo, name);
  await capturePlaywrightCheckpoint(
    page.locator('iframe[title="Email content preview"]').last(),
    testInfo,
    `${name}-email`,
  );
}

async function openThread(
  page: Page,
  emailAccountId: string,
  {
    threadId,
    subject,
    text,
  }: { threadId: string; subject: string; text: string },
) {
  await page.goto(`/${emailAccountId}/mail?thread-id=${threadId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByRole("heading", { name: subject })).toBeVisible({
    timeout: 60_000,
  });
  const frame = emailFrame(page);
  await expect(frame.getByText(text).first()).toBeVisible();
  return frame;
}

function emailFrame(page: Page) {
  return page.frameLocator('iframe[title="Email content preview"]').last();
}

/** WCAG contrast of a link's text against the nearest painted background. */
function contrastAgainstBackdrop(frame: FrameLocator, linkName: string) {
  return frame.getByRole("link", { name: linkName }).evaluate((link) => {
    const view = link.ownerDocument.defaultView!;
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.039_28
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    let element: Element | null = link;
    let background = [255, 255, 255];
    while (element) {
      const fill = parse(view.getComputedStyle(element).backgroundColor);
      if (fill.length === 3 || (fill.length === 4 && fill[3]! > 0)) {
        background = fill.slice(0, 3);
        break;
      }
      element = element.parentElement;
    }
    const text = luminance(parse(view.getComputedStyle(link).color));
    const back = luminance(background);
    return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
  });
}

type TextSample = { text: string; ratio: number; background: string };

/** Visible text below 4.5:1 against the nearest painted background. */
async function lowContrastText(frame: FrameLocator) {
  const samples = await sampleText(frame);
  return samples.filter(({ ratio }) => ratio < 4.5);
}

async function textBackgrounds(frame: FrameLocator) {
  const samples = await sampleText(frame);
  return Object.fromEntries(
    samples.map(({ text, background }) => [text, background]),
  );
}

function sampleText(frame: FrameLocator): Promise<TextSample[]> {
  return frame.locator("body").evaluate((body) => {
    const view = body.ownerDocument.defaultView!;
    const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => {
        const normalized = value / 255;
        return normalized <= 0.039_28
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const samples: TextSample[] = [];
    const walker = body.ownerDocument.createTreeWalker(
      body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent?.checkVisibility()) continue;
      let background: string | null = null;
      let overImage = false;
      for (
        let element: Element | null = parent;
        element;
        element = element.parentElement
      ) {
        const style = view.getComputedStyle(element);
        if (style.backgroundImage !== "none") {
          overImage = true;
          break;
        }
        const fill = parse(style.backgroundColor);
        if (fill.length === 3 || (fill.length === 4 && fill[3]! > 0)) {
          background = style.backgroundColor;
          break;
        }
      }
      // Text over a picture is measured against the picture, not a color.
      if (overImage) continue;
      background ??= "rgb(255, 255, 255)";
      const front = luminance(parse(view.getComputedStyle(parent).color));
      const back = luminance(parse(background));
      samples.push({
        text,
        background,
        ratio:
          Math.round(
            ((Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)) *
              100,
          ) / 100,
      });
    }
    return samples;
  });
}
