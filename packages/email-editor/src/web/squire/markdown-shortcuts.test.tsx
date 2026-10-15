// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeEditableEmailHtml } from "../../core/email-html";
import {
  EmailEditor,
  type EmailEditorHandle,
  type EmailEditorProps,
} from "../EmailEditor";

afterEach(cleanup);

// jsdom has no layout; the editor only needs a rect to position popovers.
Range.prototype.getBoundingClientRect = () => new DOMRect();

describe("markdown shortcuts at the start of a line", () => {
  it.each([
    ["- ", "ul > li"],
    ["> ", "blockquote"],
    ["# ", "h1"],
    ["## ", "h2"],
    ["### ", "h3"],
  ])("turns %j into %s", async (marker, selector) => {
    const editor = await renderEditor();

    await editor.type(`${marker}Item`);

    const element = editor.textbox().querySelector(selector);
    expect(element?.textContent).toBe("Item");
    expect(editor.textbox().textContent).not.toContain(marker.trim());
  });

  it("only converts a marker at the start of the line", async () => {
    const editor = await renderEditor();

    await editor.type("Costs - see # below ");

    expect(editor.textbox().querySelector("ul, h1")).toBeNull();
    expect(editor.text()).toBe("Costs - see # below ");
  });

  it("turns --- and Enter into a rule with the caret below it", async () => {
    const editor = await renderEditor();

    await editor.type("---");
    await editor.press("Enter");
    await editor.type("After");

    const rule = editor.textbox().querySelector("hr");
    if (!rule) throw new Error("No horizontal rule was inserted");
    expect(editor.text()).toBe("After");
    expect(
      rule.compareDocumentPosition(screenText(editor.textbox(), "After")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("turns ``` and Enter into a code block", async () => {
    const editor = await renderEditor();

    await editor.type("```ts");
    await editor.press("Enter");
    await editor.type("const a = 1;");

    expect(editor.textbox().querySelector("pre")?.textContent).toContain(
      "const a = 1;",
    );
    expect(editor.text()).not.toContain("```");
  });

  it("leaves Enter alone after other text", async () => {
    const editor = await renderEditor();

    await editor.type("Pros --- cons");
    const enter = await editor.press("Enter");

    expect(enter.defaultPrevented).toBe(false);
    expect(editor.textbox().querySelector("hr")).toBeNull();
  });
});

describe("inline markdown shortcuts", () => {
  it.each([
    ["**bold**", "b"],
    ["*italic*", "i"],
    ["_italic_", "i"],
    ["`code`", "code"],
    ["~~gone~~", "s"],
  ])("formats %s when the closing marker is typed", async (typed, tag) => {
    const editor = await renderEditor();

    await editor.type(`Say ${typed}`);

    const element = editor.textbox().querySelector(tag);
    expect(element?.textContent).toBe(typed.replace(/[*_`~]/gu, ""));
    expect(editor.text()).toBe(`Say ${element?.textContent}`);
  });

  it("continues typing outside the new formatting", async () => {
    const editor = await renderEditor();

    await editor.type("**bold** after");

    expect(editor.textbox().querySelector("b")?.textContent).toBe("bold");
    expect(editor.text()).toBe("bold after");
  });

  it("turns [label](url) into a link", async () => {
    const editor = await renderEditor();

    await editor.type("Read [the doc](example.com/doc)");

    const link = editor.textbox().querySelector("a");
    expect(link?.textContent).toBe("the doc");
    expect(link?.getAttribute("href")).toBe("https://example.com/doc");
    expect(editor.text()).toBe("Read the doc");
  });

  it.each([
    [
      "an address with a scheme",
      "[docs](https://example.com)",
      "https://example.com",
    ],
    ["an email address", "[Ada](ada@example.com)", "mailto:ada@example.com"],
  ])("links %s", async (_name, typed, href) => {
    const editor = await renderEditor();

    await editor.type(typed);

    expect(editor.textbox().querySelector("a")?.getAttribute("href")).toBe(
      href,
    );
  });

  it.each([
    ["a word", "[a](b)"],
    ["a footnote-style aside", "see [1](note)"],
  ])("leaves %s in brackets as typed", async (_name, typed) => {
    const editor = await renderEditor();

    await editor.type(typed);

    expect(editor.textbox().querySelector("a")).toBeNull();
    expect(editor.text()).toBe(typed);
  });

  it("refuses links the composer would not allow", async () => {
    const editor = await renderEditor();

    await editor.type("[x](javascript:alert(1))");

    expect(editor.textbox().querySelector("a")).toBeNull();
  });

  it.each([
    ["multiplication", "2*3*4"],
    ["snake case", "my_var_name"],
    ["spaced markers", "a * b * c"],
    ["an empty pair", "****"],
  ])("leaves %s as typed", async (_name, typed) => {
    const editor = await renderEditor();

    await editor.type(typed);

    expect(editor.textbox().querySelector("b, i, code, s")).toBeNull();
    expect(editor.text()).toBe(typed);
  });

  it("styles inline code for mail clients", async () => {
    const editor = await renderEditor();

    await editor.type("`npm i`");

    const sent = finalizeEditableEmailHtml({
      html: editor.handle().getValue().editableHtml,
      inlineAttachments: [],
      mode: "edited",
    });
    expect(sent).toMatch(/<code style="[^"]*monospace[^"]*">npm i<\/code>/u);
  });
});

describe("undoing a markdown shortcut", () => {
  it("brings back the typed characters with undo", async () => {
    const editor = await renderEditor();
    await editor.type("**bold**");
    expect(editor.textbox().querySelector("b")).toBeTruthy();

    await editor.press("z", { ctrlKey: true });

    expect(editor.textbox().querySelector("b")).toBeNull();
    expect(editor.text()).toBe("**bold**");
  });

  it("brings back the typed characters with Backspace straight after", async () => {
    const editor = await renderEditor();
    await editor.type("- ");
    expect(editor.textbox().querySelector("ul")).toBeTruthy();

    const backspace = await editor.press("Backspace");

    expect(backspace.defaultPrevented).toBe(true);
    expect(editor.textbox().querySelector("ul")).toBeNull();
    expect(editor.text().trim()).toBe("-");
  });

  it("deletes normally once the person has typed on", async () => {
    const editor = await renderEditor();
    await editor.type("# Title");

    const backspace = await editor.press("Backspace");

    expect(backspace.defaultPrevented).toBe(false);
    expect(editor.textbox().querySelector("h1")).toBeTruthy();
  });
});

describe("where markdown shortcuts stay off", () => {
  it("leaves markers inside a code block", async () => {
    const editor = await renderEditor({
      initialHtml: "<pre>x</pre>",
    });
    editor.placeCaretIn("pre");

    await editor.type(" **not bold**");

    expect(editor.textbox().querySelector("b")).toBeNull();
    expect(editor.textbox().querySelector("pre")?.textContent).toContain(
      "**not bold**",
    );
  });

  it("leaves markers inside inline code", async () => {
    const editor = await renderEditor({
      initialHtml: "<div><code>a</code></div>",
    });
    editor.placeCaretIn("code");

    await editor.type(" *b*");

    expect(editor.textbox().querySelector("i")).toBeNull();
  });

  it("leaves markers inside a quoted message", async () => {
    const editor = await renderEditor({
      initialHtml: '<blockquote type="cite"><div>Earlier</div></blockquote>',
    });
    editor.placeCaretIn("blockquote div");

    await editor.type(" **x**");

    expect(editor.textbox().querySelector("b")).toBeNull();
  });

  it("leaves markers inside the signature", async () => {
    const editor = await renderEditor({
      preservedBlocks: [
        { html: "<div>Ada Lovelace</div>", id: "signature", kind: "signature" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show signature" }));
    editor.placeCaretIn("[data-smartmail] div:last-child");

    await editor.type(" **x**");

    expect(editor.textbox().querySelector("[data-smartmail] b")).toBeNull();
  });

  it("leaves text typed through an input method", async () => {
    const editor = await renderEditor();

    await editor.type("**x**", { composing: true });

    expect(editor.textbox().querySelector("b")).toBeNull();
  });
});

describe("markdown paste", () => {
  const MARKDOWN =
    "## Plan\n\n- **Budget** approved\n- [Notes](https://example.com/n)";

  it("pastes plain-text markdown as formatted, styled email HTML", async () => {
    const editor = await renderEditor();

    const paste = await editor.paste({ "text/plain": MARKDOWN });

    expect(paste.defaultPrevented).toBe(true);
    const html = editor.handle().getValue().editableHtml;
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector("h2")?.getAttribute("style")).toMatch(
      /font-size/u,
    );
    expect(doc.querySelectorAll("li")).toHaveLength(2);
    expect(doc.querySelector("li b, li strong")?.textContent).toBe("Budget");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/n",
    );
  });

  it("removes what the sanitizer forbids from pasted markdown", async () => {
    const editor = await renderEditor();

    await editor.paste({
      "text/plain":
        "- [bad](javascript:alert(1))\n- ![x](data:image/png;base64,AA)",
    });

    const html = editor.handle().getValue().editableHtml;
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:image");
  });

  it("pastes literal text with Shift held", async () => {
    const editor = await renderEditor();
    fireEvent.keyDown(editor.textbox(), { key: "Shift", shiftKey: true });

    await editor.paste({ "text/plain": MARKDOWN });

    expect(editor.textbox().querySelector("h2, ul")).toBeNull();
    expect(editor.textbox().textContent).toContain("## Plan");
  });

  it("keeps clipboard HTML on Squire's own path", async () => {
    const editor = await renderEditor();

    await editor.paste({
      "text/html": "<p>From a web page</p>",
      "text/plain": MARKDOWN,
    });

    expect(editor.textbox().querySelector("h2")).toBeNull();
    expect(editor.textbox().textContent).toContain("From a web page");
  });

  it("pastes prose as plain text", async () => {
    const editor = await renderEditor();

    await editor.paste({ "text/plain": "Thanks, *see* you soon" });

    expect(editor.textbox().querySelector("i, em")).toBeNull();
    expect(editor.textbox().textContent).toContain("Thanks, *see* you soon");
  });
});

async function renderEditor(props: Partial<EmailEditorProps> = {}) {
  const ref = createRef<EmailEditorHandle>();
  render(<EmailEditor initialHtml="" ref={ref} {...props} />);
  // The Squire engine is loaded lazily.
  // The Squire engine loads lazily, which is slow the first time on a busy
  // machine.
  await screen.findByRole(
    "textbox",
    { name: "Email message" },
    { timeout: 10_000 },
  );
  const textbox = () => screen.getByRole("textbox", { name: "Email message" });
  const handle = () => {
    if (!ref.current) throw new Error("Editor handle is not ready");
    return ref.current;
  };

  return {
    handle,
    textbox,
    // The message text without Squire's zero-width caret placeholders.
    text: () =>
      (textbox().textContent ?? "")
        .replace(/\u200b/gu, "")
        .replace(/\u00a0/gu, " "),
    placeCaretIn(selector: string) {
      const element = textbox().querySelector(selector);
      if (!element?.lastChild) throw new Error(`No ${selector} to type in`);
      const range = document.createRange();
      range.setStart(
        element.lastChild,
        element.lastChild.textContent?.length ?? 0,
      );
      textbox().focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    // Types like a browser: the character goes in at the caret, then an
    // input event reports it.
    async type(text: string, { composing = false } = {}) {
      if (!textbox().contains(document.activeElement)) handle().focus();
      for (const character of text) {
        await act(async () => {
          const range = window.getSelection()?.getRangeAt(0);
          if (!range) throw new Error("No caret");
          let node = range.startContainer;
          let offset = range.startOffset;
          if (!(node instanceof Text)) {
            const text = document.createTextNode("");
            const before = node.childNodes[offset];
            if (before?.nodeName === "BR") before.remove();
            node.insertBefore(text, node.childNodes[offset] ?? null);
            node = text;
            offset = 0;
          }
          (node as Text).insertData(offset, character);
          range.setStart(node, offset + 1);
          range.collapse(true);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          textbox().dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              data: character,
              inputType: composing ? "insertCompositionText" : "insertText",
              isComposing: composing,
            }),
          );
        });
      }
    },
    async press(key: string, modifiers: { ctrlKey?: boolean } = {}) {
      const event = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        ...modifiers,
      });
      await act(async () => {
        textbox().dispatchEvent(event);
      });
      return event;
    },
    async paste(data: Record<string, string>) {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: {
          files: [],
          getData: (type: string) => data[type] ?? "",
          items: Object.entries(data).map(([type, value]) => ({
            getAsString: (callback: (value: string) => void) => callback(value),
            kind: "string",
            type,
          })),
          types: Object.keys(data),
        },
      });
      // Squire reports edits from a MutationObserver.
      await act(async () => {
        textbox().dispatchEvent(paste);
      });
      return paste;
    },
  };
}

function screenText(root: HTMLElement, text: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) return node;
  }
  throw new Error(`No text "${text}"`);
}
