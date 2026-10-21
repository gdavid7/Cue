// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { FileEntry, FilesQuery } from "@inboxzero/mail-core/queries";
import { FilesView } from "@/app/(app)/[emailAccountId]/mail/FilesView";

const mocks = vi.hoisted(() => ({
  queryFiles: vi.fn(),
  queryFileSenders: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({
    queryFiles: mocks.queryFiles,
    queryFileSenders: mocks.queryFileSenders,
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "a" }),
}));
vi.mock("@/hooks/useInboxUnreadCount", () => ({
  useInboxUnreadCount: () => 0,
}));
vi.mock("@/utils/user", () => ({ logOut: vi.fn() }));
vi.mock("@/utils/attachments/download", () => ({
  fetchAttachment: vi.fn(),
  getAttachmentUrl: () => "",
  saveBlob: vi.fn(),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/all-accounts-list", () => ({
  AccountRowMarker: () => null,
}));
vi.mock("@/components/email-list/EmailAttachments", () => ({
  AttachmentPreviewDialogContent: (props: { filename: string }) => {
    mocks.preview(props);
    return <div role="dialog">{props.filename}</div>;
  },
}));

describe("FilesView", () => {
  // jsdom lays nothing out, so the virtualized list is given a viewport.
  beforeAll(() => {
    for (const [property, value] of [
      ["offsetHeight", 800],
      ["offsetWidth", 400],
    ] as const)
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get: () => value,
      });
    HTMLElement.prototype.getBoundingClientRect = () =>
      ({
        width: 400,
        height: 800,
        top: 0,
        left: 0,
        bottom: 800,
        right: 400,
      }) as DOMRect;
  });
  beforeEach(() => {
    mocks.queryFiles.mockImplementation(async (query: FilesQuery) => ({
      files: [
        entry("budget.xlsx", "spreadsheet", "m1"),
        entry("contract.pdf", "pdf", "m2"),
      ].filter((file) => !query.kind || file.kind === query.kind),
      nextPage: null,
    }));
    mocks.queryFileSenders.mockResolvedValue([
      { email: "ana@example.com", name: "Ana Lima", files: 2 },
    ]);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists the account's files from the local mailbox", async () => {
    renderView();

    expect(await screen.findByText("budget.xlsx")).toBeTruthy();
    expect(screen.getByText("contract.pdf")).toBeTruthy();
    expect(mocks.queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: ["a"], kind: null, after: null }),
    );
  });

  it("narrows the list to one kind of file", async () => {
    renderView();
    await screen.findByText("budget.xlsx");

    const types = screen.getByRole("group", { name: "File type" });
    fireEvent.click(within(types).getByRole("button", { name: "PDFs" }));
    expect(
      within(types).getByRole("button", { name: "PDFs", pressed: true }),
    ).toBeTruthy();

    await waitFor(() => expect(screen.queryByText("budget.xlsx")).toBeNull());
    expect(screen.getByText("contract.pdf")).toBeTruthy();
    expect(mocks.queryFiles).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "pdf" }),
    );
  });

  it("opens the preview on click and the conversation from its own action", async () => {
    const onOpenThread = vi.fn();
    renderView(onOpenThread);

    fireEvent.click(
      await screen.findByRole("button", { name: "Preview contract.pdf" }),
    );
    expect(await screen.findByRole("dialog")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open conversation for contract.pdf",
      }),
    );
    expect(onOpenThread).toHaveBeenCalledWith("c-m2", "a");
  });

  it("keeps reading past pages that found nothing yet", async () => {
    let releaseFar: () => void = () => undefined;
    const far = new Promise<void>((resolve) => {
      releaseFar = resolve;
    });
    mocks.queryFiles.mockImplementation(async (query: FilesQuery) => {
      if (query.after === null) return { files: [], nextPage: "near" };
      if (query.after === "near") return { files: [], nextPage: "far" };
      await far;
      return { files: [entry("old.pdf", "pdf", "m9")], nextPage: null };
    });
    renderView();

    await waitFor(() => expect(mocks.queryFiles).toHaveBeenCalledTimes(3));
    // Still looking, so it neither says there are no files nor stops.
    expect(screen.queryByText(/No files/)).toBeNull();
    expect(screen.getByText("Looking through older mail…")).toBeTruthy();

    releaseFar();
    expect(await screen.findByText("old.pdf")).toBeTruthy();
    expect(screen.queryByText(/No files/)).toBeNull();
  });

  it("offers to clear filters that match nothing", async () => {
    mocks.queryFiles.mockResolvedValue({ files: [], nextPage: null });
    renderView();

    fireEvent.click(await screen.findByRole("button", { name: "Images" }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Clear filters" }),
    );
    expect(
      screen.getByRole("button", { name: "All", pressed: true }),
    ).toBeTruthy();
  });
});

function renderView(onOpenThread = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <FilesView onOpenThread={onOpenThread} />
    </SWRConfig>,
  );
}

function entry(
  filename: string,
  kind: FileEntry["kind"],
  messageId: string,
): FileEntry {
  return {
    accountId: "a",
    conversationId: `c-${messageId}`,
    messageId,
    subject: "Q3",
    from: "Ana Lima <ana@example.com>",
    receivedAtMs: Date.UTC(2026, 0, 2),
    kind,
    attachment: {
      attachmentId: `att-${messageId}`,
      filename,
      mimeType: "application/octet-stream",
      size: 2048,
      inline: false,
    },
  };
}
