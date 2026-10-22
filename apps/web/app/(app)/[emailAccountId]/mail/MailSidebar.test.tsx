/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TagIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailSidebar, type MailSidebarProps } from "./MailSidebar";
import {
  MAIL_DRAG_TYPE,
  type MailDrag,
  MailDragProvider,
  useSetMailDrag,
} from "./mail-drag";

(globalThis as { React?: typeof React }).React = React;

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/utils/mail-engine/MailEngineHost", () => ({
  useMailEngineStarting: () => false,
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function sidebar(overrides: Partial<MailSidebarProps> = {}) {
  return (
    <MailSidebar
      activeType="inbox"
      activeLabelId={null}
      activeFolderId={null}
      hrefFor={(target) =>
        target.kind === "type" ? `/mail?type=${target.type}` : "/mail"
      }
      labels={[]}
      folders={[]}
      countsById={new Map()}
      categories={[]}
      categoryHeading="Categories"
      labelsHeading="Labels"
      labelSingular="label"
      onCompose={vi.fn()}
      onCreateLabel={vi.fn()}
      onEditMailboxItem={vi.fn()}
      onDeleteMailboxItem={vi.fn()}
      labelEditMode="name-and-color"
      labelColorOptions={[]}
      {...overrides}
    />
  );
}

function renderSidebar(overrides: Partial<MailSidebarProps> = {}) {
  return render(sidebar(overrides));
}

describe("MailSidebar", () => {
  it("keeps Today in place but not a link while there is no account", () => {
    renderSidebar({ todayHref: null });

    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Today/ })).toBeNull();
  });

  it("links Today once there is an account", () => {
    renderSidebar({ todayHref: "/a/home" });

    expect(
      screen.getByRole("link", { name: /Today/ }).getAttribute("href"),
    ).toBe("/a/home");
  });

  it("switches views of the open mail screen without a server round trip", () => {
    window.history.replaceState(null, "", "/mail/u/0/inbox");
    renderSidebar({
      hrefFor: (target) =>
        target.kind === "type" ? `/mail/u/0/${target.type}` : "/mail/u/0",
    });

    fireEvent.click(screen.getByText("Sent"));

    expect(window.location.pathname).toBe("/mail/u/0/sent");
  });

  it("keeps Drafts and Sent beside the inbox and the rarer views behind More", () => {
    renderSidebar();

    expect(
      ["Inbox", "Drafts", "Sent"].map((name) =>
        screen.getByText(name).closest("a")?.getAttribute("href"),
      ),
    ).toEqual(["/mail?type=inbox", "/mail?type=draft", "/mail?type=sent"]);
    expect(screen.queryByText("Archived")).toBeNull();

    fireEvent.click(screen.getByText("More"));

    expect(
      [
        "Archived",
        "Starred",
        "Snoozed",
        "Scheduled",
        "All Mail",
        "Spam",
        "Trash",
      ].map((name) =>
        screen.getByText(name).closest("a")?.getAttribute("href"),
      ),
    ).toEqual([
      "/mail?type=archive",
      "/mail?type=starred",
      "/mail?type=snoozed",
      "/mail?type=scheduled",
      "/mail?type=all",
      "/mail?type=spam",
      "/mail?type=trash",
    ]);
    expect(screen.queryByText("Important")).toBeNull();
  });

  it("remembers an opened More group on the next visit", () => {
    renderSidebar();
    fireEvent.click(screen.getByText("More"));
    cleanup();

    renderSidebar();

    expect(screen.getByText("Trash")).toBeDefined();
  });

  it("lists the app's tools behind Tools", () => {
    renderSidebar({
      toolLinks: [
        {
          name: "Unsubscribe",
          href: "/account-1/bulk-unsubscribe",
          icon: null,
        },
      ],
    });
    expect(screen.queryByText("Unsubscribe")).toBeNull();

    fireEvent.click(screen.getByText("Tools"));

    expect(
      screen.getByText("Unsubscribe").closest("a")?.getAttribute("href"),
    ).toBe("/account-1/bulk-unsubscribe");
  });

  it("offers the Important view only where the provider has one", () => {
    renderSidebar({ supportsImportant: true });

    fireEvent.click(screen.getByText("More"));

    expect(
      screen.getByText("Important").closest("a")?.getAttribute("href"),
    ).toBe("/mail?type=important");
  });

  it("opens the More group when one of its views is showing", () => {
    renderSidebar({ activeType: "trash" });

    expect(
      screen.getByText("Trash").closest("a")?.getAttribute("aria-current"),
    ).toBe("page");
  });

  it("keeps the active view reachable in the icon rail", () => {
    renderSidebar({ activeType: "trash", collapsed: true });

    expect(screen.getByText("Trash").closest("a")?.getAttribute("href")).toBe(
      "/mail?type=trash",
    );
  });

  it("leaves the More group out of the icon rail for other views", () => {
    // Nothing in the rail can toggle the group, so a row only earns its space
    // there while its own view is open.
    renderSidebar({ activeType: "inbox", collapsed: true });

    expect(screen.queryByText("Trash")).toBeNull();
  });

  it("closes the More group in the rail once its view is left behind", () => {
    const { rerender } = renderSidebar({
      activeType: "trash",
      collapsed: true,
    });

    expect(screen.getByText("Trash")).toBeDefined();

    // The rail offers no way back out, so the group cannot outlive its view.
    rerender(sidebar({ activeType: "inbox", collapsed: true }));

    expect(screen.queryByText("Trash")).toBeNull();
  });

  it("keeps a chosen More group open across navigation when expanded", () => {
    const { rerender } = renderSidebar({ activeType: "trash" });

    rerender(sidebar({ activeType: "inbox" }));

    expect(screen.getByText("Trash")).toBeDefined();
  });

  it("closes the Categories group in the rail once its view is left behind", () => {
    const categories = [
      { name: "Promotions", type: "CATEGORY_PROMOTIONS", Icon: TagIcon },
    ];
    const { rerender } = renderSidebar({
      activeType: "CATEGORY_PROMOTIONS",
      categories,
      collapsibleCategories: true,
      collapsed: true,
    });

    expect(screen.getByText("Promotions")).toBeDefined();

    rerender(
      sidebar({
        activeType: "inbox",
        categories,
        collapsibleCategories: true,
        collapsed: true,
      }),
    );

    expect(screen.queryByText("Promotions")).toBeNull();
  });

  it("offers only the views every account can merge in the combined inbox", () => {
    renderSidebar({ unified: true });

    const links = screen.getAllByRole("link").map((link) => link.textContent);
    for (const name of ["Drafts", "Sent", "Starred", "Snoozed", "Scheduled"])
      expect(links).toContain(name);
    expect(screen.queryByText("More")).toBeNull();
    expect(screen.queryByText("Archived")).toBeNull();
    expect(screen.queryByText("Spam")).toBeNull();
    expect(screen.getByText("All inboxes")).toBeDefined();
  });

  it("shows each account's own sections in place of one account's labels in the combined inbox", () => {
    const labels = [{ id: "Label_1", name: "Receipts", type: "user" }];
    const { rerender } = renderSidebar({
      unified: true,
      labels,
      accountSections: <div>Account sections</div>,
    });

    expect(screen.getByText("Account sections")).toBeDefined();
    expect(screen.queryByText("Receipts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create label" })).toBeNull();

    // The rail has no room for per-account headings.
    rerender(
      sidebar({
        unified: true,
        collapsed: true,
        accountSections: <div>Account sections</div>,
      }),
    );
    expect(screen.queryByText("Account sections")).toBeNull();
  });

  it("offers All inboxes above a single account's inbox when it has one", () => {
    renderSidebar({ allInboxesHref: "/account-1/mail?accountScope=all" });

    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links.indexOf("All inboxes")).toBeLessThan(links.indexOf("Inbox"));
    expect(
      screen.getByText("All inboxes").closest("a")?.getAttribute("href"),
    ).toBe("/account-1/mail?accountScope=all");

    cleanup();
    renderSidebar();
    expect(screen.queryByText("All inboxes")).toBeNull();
  });
});

describe("dropping on the sidebar", () => {
  it("runs the drop for this tab's own drag", () => {
    const onDrop = vi.fn();
    renderDragging(onDrop);
    const inbox = screen.getByRole("link", { name: /^Inbox/ });

    const allowed = fireEvent.dragOver(inbox, {
      dataTransfer: transfer({ [MAIL_DRAG_TYPE]: "drag-1" }),
    });
    expect(allowed).toBe(false);
    fireEvent.drop(inbox, {
      dataTransfer: transfer({ [MAIL_DRAG_TYPE]: "drag-1" }),
    });

    expect(onDrop).toHaveBeenCalledWith({ kind: "move_to_inbox" });
  });

  it.each([
    ["a file", { Files: "" }],
    ["text", { "text/plain": "hello" }],
    ["another tab's mail drag", { [MAIL_DRAG_TYPE]: "drag-from-elsewhere" }],
  ])("ignores %s dropped while a stale drag is remembered", (_, data) => {
    const onDrop = vi.fn();
    renderDragging(onDrop);
    const inbox = screen.getByRole("link", { name: /^Inbox/ });

    fireEvent.dragEnter(inbox, { dataTransfer: transfer(data) });
    fireEvent.dragOver(inbox, { dataTransfer: transfer(data) });
    fireEvent.drop(inbox, { dataTransfer: transfer(data) });

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("highlights nothing for a foreign drag", () => {
    renderDragging(vi.fn());
    const inbox = screen.getByRole("link", { name: /^Inbox/ });

    const allowed = fireEvent.dragOver(inbox, {
      dataTransfer: transfer({ Files: "" }),
    });

    expect(allowed).toBe(true);
    expect(inbox.getAttribute("data-drop")).toBeNull();
  });

  it("forgets a drag once the pointer moves again outside a drag", () => {
    const onDrop = vi.fn();
    renderDragging(onDrop);
    const inbox = screen.getByRole("link", { name: /^Inbox/ });

    fireEvent.mouseMove(document.body);
    fireEvent.drop(inbox, {
      dataTransfer: transfer({ [MAIL_DRAG_TYPE]: "drag-1" }),
    });

    expect(onDrop).not.toHaveBeenCalled();
  });
});

/** A drag started from the list and never ended, as when its row unmounts. */
function renderDragging(onDrop: MailDrag["onDrop"]) {
  render(
    <MailDragProvider>
      <StartDrag
        drag={{
          nonce: "drag-1",
          conversations: [
            {
              key: "t1",
              threadId: "t1",
              accountId: "a1",
              messages: [{ labelIds: [] }],
            },
          ],
          onDrop,
        }}
      />
      {sidebar({ activeType: "sent" })}
    </MailDragProvider>,
  );
}

function StartDrag({ drag }: { drag: MailDrag }) {
  const setDrag = useSetMailDrag();
  React.useEffect(() => setDrag(drag), [drag, setDrag]);
  return null;
}

function transfer(data: Record<string, string>) {
  return {
    types: Object.keys(data),
    getData: (type: string) => data[type] ?? "",
    dropEffect: "none",
  };
}
