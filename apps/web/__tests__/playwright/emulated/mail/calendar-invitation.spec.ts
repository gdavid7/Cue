import { expect } from "@playwright/test";
import { getEmailAccountId } from "../account-test-helpers";
import { test } from "../playwright-test";

// The card renders the meeting time in the viewer's timezone.
test.use({ timezoneId: "UTC" });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("shows inline calendar responses with the current RSVP", async ({
  page,
}, testInfo) => {
  await page.route("**/api/messages/calendar-invitation?**", (route) =>
    route.fulfill({
      json: {
        invitation: {
          title: "Project planning",
          organizer: "organizer@example.com",
          recurring: false,
          response: "accepted",
          calendarSynced: true,
          start: "2026-10-01T10:00:00.000Z",
          end: "2026-10-01T10:30:00.000Z",
          allDay: false,
          location: "Meeting room 2",
          conferenceUrl: "https://meet.google.com/abc-defg-hij",
        },
      },
    }),
  );
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/mail?thread-id=thr_playwright_calendar`);
  await expect(
    page.locator('li[data-thread-message-id="msg_playwright_calendar"]'),
  ).toBeVisible({ timeout: 60_000 });
  const card = page.getByLabel("Calendar invitation", { exact: true });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(
    card.getByRole("button", { name: "Yes", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    card.getByRole("button", { name: "No", exact: true }),
  ).toBeEnabled();
  await expect(
    card.getByRole("button", { name: "Maybe", exact: true }),
  ).toBeEnabled();
  await expect(
    card.getByText("Thursday, October 1, 2026 · 10:00 AM – 10:30 AM"),
  ).toBeVisible();
  await expect(card.getByText("Meeting room 2")).toBeVisible();
  await expect(
    card.getByRole("link", { name: "meet.google.com/abc-defg-hij" }),
  ).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
  await expect(card.getByText("organizer@example.com")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("calendar-invitation-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("calendar-invitation-mobile.png"),
    fullPage: true,
  });
});

// Client-only: the conflicts route is mocked, so this covers the card's
// request and wording, not the server's calendar reads.
test("says what an upcoming invitation conflicts with", async ({
  page,
}, testInfo) => {
  const conflictRequests: URL[] = [];
  await page.route("**/api/messages/calendar-invitation?**", (route) =>
    route.fulfill({
      json: {
        invitation: {
          uid: "playwright-invite@example.com",
          title: "Quarterly review",
          organizer: "organizer@example.com",
          recurring: false,
          response: null,
          calendarSynced: true,
          start: "2030-03-04T15:00:00.000Z",
          end: "2030-03-04T16:00:00.000Z",
          allDay: false,
          location: null,
          conferenceUrl: null,
        },
      },
    }),
  );
  await page.route("**/api/user/calendar/conflicts?**", (route) => {
    conflictRequests.push(new URL(route.request().url()));
    return route.fulfill({
      json: {
        status: "ok",
        // In start order, as the server sends them.
        conflicts: [
          {
            title: "Hiring sync",
            start: "2030-03-04T14:30:00.000Z",
            end: "2030-03-04T15:15:00.000Z",
          },
          // The invitation itself, on a calendar that rewrote its UID.
          {
            title: "Quarterly review",
            start: "2030-03-04T15:00:00.000Z",
            end: "2030-03-04T16:00:00.000Z",
          },
          {
            title: "Design review",
            start: "2030-03-04T15:30:00.000Z",
            end: "2030-03-04T16:30:00.000Z",
          },
        ],
      },
    });
  });
  const emailAccountId = await getEmailAccountId(page);
  await page.goto(`/${emailAccountId}/mail?thread-id=thr_playwright_calendar`);
  const card = page.getByLabel("Calendar invitation", { exact: true });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(
    card.getByText("Monday, March 4, 2030 · 3:00 PM – 4:00 PM"),
  ).toBeVisible();
  await expect(card.getByText("Conflicts with Hiring sync")).toBeVisible();
  await expect(card.getByText("and 1 more")).toBeVisible();
  expect(conflictRequests[0]?.searchParams.get("start")).toBe(
    "2030-03-04T15:00:00.000Z",
  );
  expect(conflictRequests[0]?.searchParams.get("uid")).toBe(
    "playwright-invite@example.com",
  );
  await page.screenshot({
    path: testInfo.outputPath("calendar-invitation-conflict-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByText("Conflicts with Hiring sync")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("calendar-invitation-conflict-mobile.png"),
    fullPage: true,
  });
});
