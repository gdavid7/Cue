import { expect } from "@playwright/test";
import type { ThreadResponse } from "@/app/api/threads/[id]/route";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { test } from "../playwright-test";
import { capturePlaywrightCheckpoint } from "../playwright-evidence";
import {
  conversationWithSubject,
  expectSeamlessReplyHandoff,
  openMail,
  readLatestMailMutation,
  UNDO_WINDOW_SEND_TIMEOUT_MS,
  watchReplyHandoff,
} from "./mail-test-helpers";

test("sends an autosaved reply using its stable mailbox draft reference", async ({
  page,
}, testInfo) => {
  const { conversations, emailAccountId } = await openMail(page);
  await conversationWithSubject(
    page,
    conversations,
    "Draft deletion example",
  ).click();
  // The newest of the conversation's two drafts is the one open.
  const editor = page.getByRole("textbox", { name: "Email message" });
  await expect(editor).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("collapsed-draft")).toHaveCount(1);
  const saved = page.waitForResponse(async (response) => {
    const request = response.request();
    return Boolean(
      request.headers()["next-action"] &&
        request.postData()?.includes("Edited saved reply") &&
        request.postData()?.includes("draftMessageId"),
    );
  });
  await editor.fill("Edited saved reply");
  expect((await saved).ok()).toBe(true);
  const handoff = await watchReplyHandoff(page, "Edited saved reply");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect
    .poll(
      async () => {
        const row = await readLatestMailMutation(page, {
          emailAccountId,
          kind: "reply",
          threadId: "thr_draft_indicator",
        });
        return row;
      },
      { timeout: UNDO_WINDOW_SEND_TIMEOUT_MS },
    )
    .toMatchObject({
      status: "succeeded",
    });
  const response = await page.request.get(
    new URL(
      "/api/threads/thr_draft_indicator?includeDrafts=true",
      page.url(),
    ).toString(),
    { headers: { [EMAIL_ACCOUNT_HEADER]: emailAccountId } },
  );
  expect(response.ok()).toBe(true);
  const { thread }: ThreadResponse = await response.json();
  expect(
    thread.messages.filter((message) => message.labelIds?.includes("DRAFT")),
  ).toHaveLength(1);
  const sent = thread.messages.filter((message) =>
    message.labelIds?.includes("SENT"),
  );
  expect(sent).toHaveLength(1);
  expect(sent[0].textHtml).toContain("Edited saved reply");
  await expect(
    page.locator(`[data-thread-message-id="${sent[0].id}"]`),
  ).toBeVisible();
  // The saved draft leaves at the same moment its sent message arrives.
  expectSeamlessReplyHandoff(await handoff.stop(), handoff.rowsBefore);
  await page.goto(`/${emailAccountId}/mail?thread-id=thr_draft_indicator`);
  await expect(
    page.locator(`[data-thread-message-id="${sent[0].id}"]`),
  ).toBeVisible();
  // The other draft is now the only one, so it is open.
  await expect(
    page.getByRole("textbox", { name: "Email message" }),
  ).toBeVisible();
  await expect(page.getByTestId("collapsed-draft")).toHaveCount(0);
  await expect(
    page.getByText("Reply could not be sent", { exact: true }),
  ).toHaveCount(0);
  await capturePlaywrightCheckpoint(page, testInfo, "autosaved-reply-sent");
});
