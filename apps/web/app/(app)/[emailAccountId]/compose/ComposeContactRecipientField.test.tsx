// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { MailEngineProvider } from "@inboxzero/mail-react/MailEngineProvider";
import { env } from "@/env";
import { ComposeContactRecipientField } from "./ComposeContactRecipientField";

vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_CONTACTS_ENABLED: false } }));
const local = vi.fn();
const api = vi.fn();
const pending = vi.fn();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  local.mockResolvedValue([
    { name: "Jane Local", emailAddress: "jane@example.com" },
  ]);
  api.mockResolvedValue({
    contacts: [
      { name: "Jane API", emailAddress: "JANE@example.com" },
      { name: "Janet API", emailAddress: "janet@example.com" },
    ],
  });
});

describe("compose contact suggestions", () => {
  it("suggests and selects local recipients with contacts disabled, without an API call", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox", { name: "To" }), {
      target: { value: "jan" },
    });
    fireEvent.mouseDown(
      await screen.findByRole("option", { name: /Jane Local/ }),
      { button: 0 },
    );
    expect(
      await screen.findByRole("button", { name: "Remove jane@example.com" }),
    ).toBeTruthy();
    expect(api).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "send-account",
        ownAddresses: ["me@example.com"],
        query: "jan",
      }),
    );
    fireEvent.change(screen.getByRole("combobox", { name: "To" }), {
      target: { value: "jan" },
    });
    await waitFor(() => expect(local).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("option", { name: /Jane Local/ })).toBeNull();
  });

  it("merges API and local results with the flag on", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = true;
    render(<Harness />);
    fireEvent.change(screen.getByRole("combobox", { name: "To" }), {
      target: { value: "jan" },
    });
    await screen.findByRole("option", { name: /Janet API/ });
    await screen.findByRole("option", { name: /Jane Local/ });
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("commits pasted recipient lists with names while the contacts flag is off", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, {
      target: { value: '"Doe, Jane" <jane@example.com>, second@example.com' },
    });
    fireEvent.keyUp(input, { key: "Enter" });
    expect(
      await screen.findByRole("button", {
        name: 'Remove "Doe, Jane" <jane@example.com>',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove second@example.com" }),
    ).toBeTruthy();
  });

  it("commits a typed address on comma and when leaving the field", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "first@example.com" } });
    fireEvent.keyDown(input, { key: "," });
    expect(
      await screen.findByRole("button", { name: "Remove first@example.com" }),
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: "second@example.com" } });
    fireEvent.blur(input);
    expect(
      await screen.findByRole("button", { name: "Remove second@example.com" }),
    ).toBeTruthy();
  });

  it("keeps local suggestions available alongside the API reconnect-required prompt", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = true;
    render(<Harness reconnectRequired />);
    expect(screen.getByRole("status").textContent).toContain(
      "Reconnect this account",
    );
    fireEvent.change(screen.getByRole("combobox", { name: "To" }), {
      target: { value: "jan" },
    });
    await screen.findByRole("option", { name: /Jane Local/ });
    expect(api).not.toHaveBeenCalled();
  });

  it("picks the top suggestion on Enter and the highlighted one on Tab", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    local.mockResolvedValue([
      { name: "Jane Local", emailAddress: "jane@example.com" },
      { name: "Janet Local", emailAddress: "janet@example.com" },
    ]);
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "jan" } });
    await screen.findByRole("option", { name: /Janet Local/ });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyUp(input, { key: "Enter" });
    expect(
      await screen.findByRole("button", { name: "Remove jane@example.com" }),
    ).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");

    local.mockResolvedValue([
      { name: "Janet Local", emailAddress: "janet@example.com" },
      { name: "Janis Local", emailAddress: "janis@example.com" },
    ]);
    fireEvent.change(input, { target: { value: "jan" } });
    await screen.findByRole("option", { name: /Janis Local/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.blur(input);
    expect(
      await screen.findByRole("button", { name: "Remove janis@example.com" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove janet@example.com" }),
    ).toBeNull();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("turns a pasted list of addresses into recipients at once", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "first@example.com, Second <second@example.com>",
      },
    });
    expect(
      await screen.findByRole("button", { name: "Remove first@example.com" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Remove Second <second@example.com>",
      }),
    ).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("keeps a complete typed address over a different top suggestion on Enter and Tab", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    local.mockResolvedValue([
      { name: "Dan Acme", emailAddress: "dan@acme.com" },
    ]);
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "dan@acme.co" } });
    await screen.findByRole("option", { name: /Dan Acme/ });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyUp(input, { key: "Enter" });
    expect(
      await screen.findByRole("button", { name: "Remove dan@acme.co" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove dan@acme.com" }),
    ).toBeNull();

    fireEvent.change(input, { target: { value: "dana@acme.co" } });
    await screen.findByRole("option", { name: /Dan Acme/ });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.blur(input);
    expect(
      await screen.findByRole("button", { name: "Remove dana@acme.co" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Remove dan@acme.com" }),
    ).toBeNull();
  });

  it("picks the arrowed-to suggestion over a typed address, once, when Tab leaves the field", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    local.mockResolvedValue([
      { name: "Jane Local", emailAddress: "jane@example.com" },
      { name: "Janet Local", emailAddress: "janet@example.com" },
    ]);
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "jane@example.co" } });
    await screen.findByRole("option", { name: /Janet Local/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.blur(input);
    await screen.findByRole("button", { name: "Remove janet@example.com" });
    expect(
      screen
        .getAllByRole("button")
        .filter((button) =>
          button.getAttribute("aria-label")?.startsWith("Remove "),
        )
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Remove janet@example.com"]);
  });

  it("ignores Enter and Tab while an input method is composing", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "jan@example.com" } });
    await screen.findByRole("option", { name: /Jane Local/ });
    fireEvent.keyDown(input, { key: "Tab", isComposing: true });
    fireEvent.keyUp(input, { key: "Enter", isComposing: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect((input as HTMLInputElement).value).toBe("jan@example.com");
  });

  it("chips a pasted list with a quoted comma name, and separators from Outlook or a sheet", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.paste(input, {
      clipboardData: { getData: () => '"Doe, John" <j@x.com>, k@x.com' },
    });
    expect(
      await screen.findByRole("button", {
        name: 'Remove "Doe, John" <j@x.com>',
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove k@x.com" })).toBeTruthy();

    fireEvent.paste(input, {
      clipboardData: { getData: () => "l@x.com; m@x.com\nn@x.com" },
    });
    for (const address of ["l@x.com", "m@x.com", "n@x.com"])
      expect(
        await screen.findByRole("button", { name: `Remove ${address}` }),
      ).toBeTruthy();
  });

  it("leaves a mixed valid and invalid paste, or a paste into typed text, to the browser", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    const mixed = fireEvent.paste(input, {
      clipboardData: { getData: () => "ok@x.com, not-an-address" },
    });
    expect(mixed).toBe(true);
    fireEvent.change(input, { target: { value: "bo" } });
    const intoText = fireEvent.paste(input, {
      clipboardData: { getData: () => "b@x.com" },
    });
    expect(intoText).toBe(true);
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("asks only an engine that reports suggestions, and still takes typed recipients", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    render(<Harness engineAnswers={false} />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "jan" } });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(local).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "jane@example.com" } });
    fireEvent.keyUp(input, { key: "Enter" });
    expect(
      await screen.findByRole("button", { name: "Remove jane@example.com" }),
    ).toBeTruthy();
  });

  it("discards stale queries and still accepts free-typed recipients when unavailable", async () => {
    env.NEXT_PUBLIC_CONTACTS_ENABLED = false;
    let resolveOld: (value: unknown) => void = () => {};
    local.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "To" });
    fireEvent.change(input, { target: { value: "old" } });
    await waitFor(() => expect(local).toHaveBeenCalledTimes(1));
    local.mockRejectedValue(new Error("unavailable"));
    fireEvent.change(input, { target: { value: "manual@example.com" } });
    await waitFor(() => expect(local).toHaveBeenCalledTimes(2));
    resolveOld([{ name: "Old", emailAddress: "old@example.com" }]);
    fireEvent.keyUp(input, { key: "Enter" });
    expect(
      await screen.findByRole("button", { name: "Remove manual@example.com" }),
    ).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });
});

function Harness({
  engineAnswers = true,
  reconnectRequired = false,
}: {
  engineAnswers?: boolean;
  reconnectRequired?: boolean;
}) {
  const [recipients, setRecipients] = useState("");
  return (
    <SWRConfig value={{ provider: () => new Map(), fetcher: api }}>
      <MailEngineProvider
        client={
          (engineAnswers
            ? {
                capabilities: ["method:queryContactSuggestions"],
                queryContactSuggestions: local,
              }
            : { queryContactSuggestions: local }) as unknown as MailClient
        }
      >
        <ComposeContactRecipientField
          active
          emailAccountId="send-account"
          ownAddresses={["me@example.com"]}
          name="to"
          isReconnectingContacts={false}
          reconnectRequired={reconnectRequired}
          selectedRecipients={recipients}
          onActivate={vi.fn()}
          onReconnectContacts={vi.fn()}
          onReconnectRequired={vi.fn()}
          onSearchQueryChange={pending}
          onSelectedRecipientsChange={(_, value) => setRecipients(value)}
        />
      </MailEngineProvider>
    </SWRConfig>
  );
}
