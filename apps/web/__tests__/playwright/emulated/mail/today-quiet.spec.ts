import { expect, type Page, type Route } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import { test } from "../playwright-test";
import { withClient } from "./mail-test-helpers";

// A precise fix, which Cue should only ever store rounded.
const HERE = { latitude: 37.774_929, longitude: -122.419_416 };
const FORECAST = {
  current: { temperature_2m: 17.6, weather_code: 2 },
  daily: { temperature_2m_max: [21.2], temperature_2m_min: [11.8] },
};
const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

test.beforeEach(async ({ page }) => {
  await setTodayWeather(await getEmailAccountId(page), null);
});

test.afterEach(async ({ page }) => {
  await setTodayWeather(await getEmailAccountId(page), null);
});

test("a quiet day: All clear, how tomorrow starts, Cue's drafts and who you're waiting on", async ({
  page,
}, testInfo) => {
  test.setTimeout(480_000);
  const weatherRequests = await mockWeather(page);
  // The real answer, made quiet: nothing needs a reply, tomorrow has a
  // meeting, Cue drafted a reply, and one conversation waits on someone.
  await page.route("**/api/user/home*", async (route) => {
    const response = await route.fetch();
    const home = await response.json();
    const sample = [...home.needsYou, ...home.alsoInInbox, ...home.waiting][0];
    home.cue = { aiAccess: true, replyTracking: true, hasReadMail: true };
    home.needsYou = [];
    home.waiting = sample ? [sample] : [];
    home.alsoInInbox = [];
    home.calendar = {
      connected: true,
      next: {
        title: "Design review",
        at: new Date(Date.now() + 86_400_000).toISOString(),
        tomorrow: true,
      },
    };
    home.agentTasks = sample
      ? [
          {
            id: "playwright-quiet-draft",
            kind: "draft",
            threadId: sample.threadId,
            title: `Suggested reply: ${sample.subject}`,
            detail: "Ready for your review",
            at: new Date().toISOString(),
          },
        ]
      : [];
    await route.fulfill({ response, json: home });
  });
  const main = page.getByRole("main");

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await openToday(page);
    const status = main.getByRole("status");
    await expect(status).toContainText("All clear.", { timeout: 60_000 });
    await expect(status).toHaveCount(1);
    await expect(main.getByText(/^Tomorrow starts with/)).toContainText(
      "Design review",
    );
    await expect(
      main.getByRole("heading", { name: /^Drafts ready for you/ }),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: "Waiting on 1 person" }),
    ).toBeVisible();
    // Off until asked for: no location asked for, and no weather fetched.
    await expect(
      main.getByRole("button", { name: "Show weather" }),
    ).toBeVisible();
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await expectNoSideScroll(page, size.width);
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-quiet-${theme}-${size.width}`,
      );
    }
    await page.setViewportSize(SIZES[0]);
  }
  expect(weatherRequests).toEqual([]);
});

test("weather: on only when asked, from this browser, stored coarse, and off again", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(480_000);
  const weatherRequests = await mockWeather(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation(HERE);
  const emailAccountId = await getEmailAccountId(page);
  const main = page.getByRole("main");

  await openToday(page);
  const showWeather = main.getByRole("button", { name: "Show weather" });
  await expect(showWeather).toBeVisible({ timeout: 60_000 });
  expect(weatherRequests).toEqual([]);

  await showWeather.click();
  await page.getByRole("button", { name: "Use my location" }).click();
  const line = main.getByRole("button", { name: /^18°/ });
  await expect(line).toContainText("Partly cloudy");
  await expect(line).toContainText("H 21° L 12°");
  // Rounded before it's stored or sent anywhere.
  await expect
    .poll(() => readTodayWeather(emailAccountId))
    .toEqual({ latitude: 37.8, longitude: -122.4 });
  const forecast = weatherRequests.find(
    (url) => url.hostname === "api.open-meteo.com",
  );
  expect(forecast?.searchParams.get("latitude")).toBe("37.8");
  expect(forecast?.searchParams.get("longitude")).toBe("-122.4");

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((value) => {
      localStorage.setItem("theme", value);
    }, theme);
    await openToday(page);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await expect(line).toBeVisible({ timeout: 60_000 });
      await expectNoSideScroll(page, size.width);
      await capturePlaywrightCheckpoint(
        page,
        testInfo,
        `today-weather-${theme}-${size.width}`,
      );
    }
    await page.setViewportSize(SIZES[0]);
  }

  // A city the user types instead.
  await line.click();
  await page.getByRole("textbox", { name: "City" }).fill("Lisbon");
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(main.getByRole("button", { name: /Lisbon$/ })).toBeVisible();
  await expect
    .poll(() => readTodayWeather(emailAccountId))
    .toEqual({ latitude: 38.7, longitude: -9.1, label: "Lisbon" });

  // Kept in the user's settings, so it's there after a reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(main.getByRole("button", { name: /Lisbon$/ })).toBeVisible({
    timeout: 60_000,
  });

  await main.getByRole("button", { name: /Lisbon$/ }).click();
  await capturePlaywrightCheckpoint(page, testInfo, "today-weather-settings");
  await page.getByRole("button", { name: "Turn off weather" }).click();
  await expect(
    main.getByRole("button", { name: "Show weather" }),
  ).toBeVisible();
  await expect.poll(() => readTodayWeather(emailAccountId)).toBeNull();
});

test("weather service down: Today stays calm and the weather can be turned off", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const emailAccountId = await getEmailAccountId(page);
  await setTodayWeather(emailAccountId, {
    latitude: 38.7,
    longitude: -9.1,
    label: "Lisbon",
  });
  await page.route("https://api.open-meteo.com/**", (route) =>
    route.fulfill({ status: 503, body: "" }),
  );
  const main = page.getByRole("main");

  await openToday(page);
  const line = main.getByRole("button", { name: "Lisbon" });
  await expect(line).toBeVisible({ timeout: 60_000 });
  // Nothing on Today calls out the outage (Next's route announcer is outside main).
  await expect(main.getByRole("alert")).toHaveCount(0);
  await expect(main.getByText(/weather/i)).toHaveCount(0);

  await line.click();
  await page.getByRole("button", { name: "Turn off weather" }).click();
  await expect(
    main.getByRole("button", { name: "Show weather" }),
  ).toBeVisible();
});

/** Open-Meteo, answered here, so the suite never reaches the network. */
async function mockWeather(page: Page) {
  const requests: URL[] = [];
  const answer = (body: unknown) => async (route: Route) => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({
      json: body,
      headers: { "access-control-allow-origin": "*" },
    });
  };
  await page.route("https://api.open-meteo.com/**", answer(FORECAST));
  await page.route(
    "https://geocoding-api.open-meteo.com/**",
    answer({
      results: [{ name: "Lisbon", latitude: 38.716_67, longitude: -9.133_33 }],
    }),
  );
  return requests;
}

async function openToday(page: Page) {
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/home`, {
    waitUntil: "domcontentloaded",
  });
}

async function expectNoSideScroll(page: Page, width: number) {
  const scrollWidth = await page.evaluate(
    () => document.documentElement.scrollWidth,
  );
  expect(scrollWidth).toBeLessThanOrEqual(width);
}

async function setTodayWeather(
  emailAccountId: string,
  location: { latitude: number; longitude: number; label?: string } | null,
) {
  await withClient((client) =>
    client.query(
      `UPDATE "User" SET "todayWeather" = $2::jsonb
       WHERE id = (SELECT "userId" FROM "EmailAccount" WHERE id = $1)`,
      [emailAccountId, location ? JSON.stringify(location) : null],
    ),
  );
}

async function readTodayWeather(emailAccountId: string) {
  return withClient(async (client) => {
    const result = await client.query<{ todayWeather: unknown }>(
      `SELECT u."todayWeather" FROM "User" u
       JOIN "EmailAccount" e ON e."userId" = u.id WHERE e.id = $1`,
      [emailAccountId],
    );
    return result.rows[0]?.todayWeather ?? null;
  });
}
