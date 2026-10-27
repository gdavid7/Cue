// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecipientLocalTime } from "./RecipientLocalTime";

const ANA = "ana@example.com";
// The test machine's own offset never equals Ana's: pick hers from it.
const OWN_OFFSETS = [
  Date.UTC(2026, 9, 26, 2, 12),
  Date.UTC(2026, 9, 25, 9),
].map((ms) => -new Date(ms).getTimezoneOffset());
const ANA_OFFSET = OWN_OFFSETS.includes(60) ? 180 : 60;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 03:12 or 05:12 for Ana, before her day starts.
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 26, 2, 12)));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderLine(
  overrides: Partial<Parameters<typeof RecipientLocalTime>[0]> = {},
) {
  const onSendAt = vi.fn();
  render(
    <RecipientLocalTime
      senderUtcOffsets={{
        [ANA]: {
          offsetMinutes: ANA_OFFSET,
          sentAt: Date.UTC(2026, 9, 25, 9),
        },
      }}
      recipientHeaders={[`Ana <${ANA}>`, "", ""]}
      ownEmails={["me@example.com"]}
      sendAt=""
      onSendAt={onSendAt}
      {...overrides}
    />,
  );
  return onSendAt;
}

describe("RecipientLocalTime", () => {
  it("shows their time and schedules the send for their next 8:00", () => {
    const onSendAt = renderLine();
    expect(screen.getByText(/^(?!Send at).*their time$/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /^Send at .+ their time$/ }),
    );
    expect(onSendAt).toHaveBeenCalledWith(
      new Date(Date.UTC(2026, 9, 26, 8 - ANA_OFFSET / 60)).toISOString(),
    );
  });

  it("offers no send time once Send later is set, or where the composer can't schedule", () => {
    renderLine({ sendAt: "2026-10-27T09:00:00.000Z" });
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();
    renderLine({ onSendAt: undefined });
    expect(screen.getByText(/^(?!Send at).*their time$/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing for more than one recipient, ignoring the user's own address", () => {
    renderLine({
      recipientHeaders: [`Ana <${ANA}>, me@example.com`, "", ""],
    });
    expect(screen.getByText(/^(?!Send at).*their time$/)).toBeTruthy();
    cleanup();
    renderLine({ recipientHeaders: [`Ana <${ANA}>`, "ben@example.com", ""] });
    expect(screen.queryByText(/their time/)).toBeNull();
  });
});
