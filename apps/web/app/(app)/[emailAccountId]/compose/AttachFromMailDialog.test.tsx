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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry, FilesQuery } from "@inboxzero/mail-core/queries";
import { AttachFromMailDialog } from "@/app/(app)/[emailAccountId]/compose/AttachFromMailDialog";

const mocks = vi.hoisted(() => ({
  queryFiles: vi.fn(),
  fetchAttachment: vi.fn(),
  toastError: vi.fn(),
  accounts: [] as Array<{
    id: string;
    email: string;
    account: { disconnectedAt: string | null };
  }>,
}));

vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({ queryFiles: mocks.queryFiles }),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ data: { emailAccounts: mocks.accounts } }),
}));
vi.mock("@/utils/attachments/download", () => ({
  fetchAttachment: mocks.fetchAttachment,
  getAttachmentUrl: ({
    accountId,
    messageId,
    attachmentId,
  }: {
    accountId: string;
    messageId: string;
    attachmentId: string;
  }) => `/attachment/${accountId}/${messageId}/${attachmentId}`,
}));
vi.mock("@/components/Toast", () => ({ toastError: mocks.toastError }));

const ANA = { email: "ana@example.com", label: "Ana Lima" };

describe("AttachFromMailDialog", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    HTMLElement.prototype.scrollIntoView ??= () => undefined;
    mocks.accounts = [];
    mocks.queryFiles.mockImplementation(async (query: FilesQuery) => ({
      files: [
        entry("contract.pdf", "pdf", "m1", "Ana Lima <ana@example.com>"),
        entry("budget.xlsx", "spreadsheet", "m2", "Bo <bo@example.com>"),
      ].filter(
        (file) =>
          (!query.kind || file.kind === query.kind) &&
          (!query.sender || file.from.includes(query.sender)),
      ),
      nextPage: null,
    }));
    mocks.fetchAttachment.mockResolvedValue(
      new Blob(["%PDF"], { type: "application/pdf" }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("lists files from the recipients first, then every other file", async () => {
    renderDialog({ senders: [ANA] });

    const fromAna = await screen.findByRole("group", {
      name: "Files from Ana Lima",
    });
    expect(
      await within(fromAna).findByRole("option", { name: /contract\.pdf/ }),
    ).toBeTruthy();
    expect(mocks.queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({ sender: "ana@example.com", accountIds: ["a"] }),
    );

    const all = screen.getByRole("group", { name: "All files" });
    expect(
      await within(all).findByRole("option", { name: /budget\.xlsx/ }),
    ).toBeTruthy();
    // A recipient's file isn't listed a second time below.
    expect(
      within(all).queryByRole("option", { name: /contract\.pdf/ }),
    ).toBeNull();
  });

  it("lists every file in one group when there are no recipients yet", async () => {
    renderDialog({ senders: [] });

    expect(
      await screen.findByRole("option", { name: /contract\.pdf/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Files from/ })).toBeNull();
    expect(mocks.queryFiles).not.toHaveBeenCalledWith(
      expect.objectContaining({ sender: expect.any(String) }),
    );
  });

  it("narrows every group by type and by name", async () => {
    renderDialog({ senders: [ANA] });
    await screen.findByRole("option", { name: /budget\.xlsx/ });

    const types = screen.getByRole("group", { name: "File type" });
    fireEvent.click(within(types).getByRole("button", { name: "PDFs" }));
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /budget\.xlsx/ })).toBeNull(),
    );
    expect(mocks.queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pdf", sender: "ana@example.com" }),
    );
    expect(mocks.queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pdf", sender: null }),
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "contract" },
    });
    await waitFor(() =>
      expect(mocks.queryFiles).toHaveBeenCalledWith(
        expect.objectContaining({ name: "contract", sender: null }),
      ),
    );
  });

  it("searches every connected account, not just the one sending", async () => {
    mocks.accounts = [
      { id: "a", email: "me@example.com", account: { disconnectedAt: null } },
      { id: "b", email: "work@example.com", account: { disconnectedAt: null } },
      {
        id: "c",
        email: "old@example.com",
        account: { disconnectedAt: "2026-01-01" },
      },
    ];
    renderDialog({ senders: [] });

    await screen.findByRole("option", { name: /contract\.pdf/ });
    expect(mocks.queryFiles).toHaveBeenCalledWith(
      expect.objectContaining({ accountIds: ["a", "b"] }),
    );
  });

  it("reads the chosen file with the account holding it and hands it to the composer", async () => {
    mocks.accounts = [
      { id: "a", email: "me@example.com", account: { disconnectedAt: null } },
      { id: "b", email: "work@example.com", account: { disconnectedAt: null } },
    ];
    mocks.queryFiles.mockResolvedValue({
      files: [
        {
          ...entry("contract.pdf", "pdf", "m1", "Ana <ana@example.com>"),
          accountId: "b",
          attachment: {
            attachmentId: "att-m1",
            filename: "contract.pdf",
            mimeType: "application/pdf",
            size: 4,
            inline: false,
          },
        },
      ],
      nextPage: null,
    });
    const { onAttach, onOpenChange } = renderDialog({ senders: [] });

    fireEvent.click(await screen.findByRole("option", { name: /contract/ }));

    await waitFor(() => expect(onAttach).toHaveBeenCalledOnce());
    expect(mocks.fetchAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "/attachment/b/m1/att-m1",
        emailAccountId: "b",
      }),
    );
    const file = onAttach.mock.calls[0][0] as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("contract.pdf");
    expect(file.type).toBe("application/pdf");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows how much of the file has arrived while it downloads", async () => {
    let finish: (blob: Blob) => void = () => undefined;
    mocks.fetchAttachment.mockImplementation(
      ({ onProgress }: { onProgress: (bytes: number) => void }) =>
        new Promise<Blob>((resolve) => {
          onProgress(1024);
          finish = resolve;
        }),
    );
    const { onAttach } = renderDialog({ senders: [] });

    fireEvent.click(
      await screen.findByRole("option", { name: /contract\.pdf/ }),
    );

    const progress = await screen.findByRole("progressbar", {
      name: "Attaching contract.pdf",
    });
    expect(progress.getAttribute("aria-valuenow")).toBe("50");
    finish(new Blob(["x"]));
    await waitFor(() => expect(onAttach).toHaveBeenCalledOnce());
  });

  it("stops the download when the picker closes", async () => {
    let signal: AbortSignal | undefined;
    mocks.fetchAttachment.mockImplementation(
      (options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise<Blob>(() => undefined);
      },
    );
    const { onAttach, rerender } = renderDialog({ senders: [] });

    fireEvent.click(
      await screen.findByRole("option", { name: /contract\.pdf/ }),
    );
    await waitFor(() => expect(signal).toBeDefined());
    rerender(false);

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("refuses a file that wouldn't fit before downloading it", async () => {
    const { onAttach } = renderDialog({
      senders: [],
      checkFits: () => "contract.pdf wasn't attached. Too large.",
    });

    fireEvent.click(
      await screen.findByRole("option", { name: /contract\.pdf/ }),
    );

    expect(mocks.toastError).toHaveBeenCalledWith({
      description: "contract.pdf wasn't attached. Too large.",
    });
    expect(mocks.fetchAttachment).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
  });

  it("reports a download that fails and stays open", async () => {
    mocks.fetchAttachment.mockRejectedValue(new Error("offline"));
    const { onAttach, onOpenChange } = renderDialog({ senders: [] });

    fireEvent.click(
      await screen.findByRole("option", { name: /contract\.pdf/ }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith({
        description: "Could not attach contract.pdf.",
      }),
    );
    expect(onAttach).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("says where older mail's files are when nothing is listed", async () => {
    mocks.queryFiles.mockResolvedValue({ files: [], nextPage: null });
    renderDialog({ senders: [] });

    expect(await screen.findByText("No files yet.")).toBeTruthy();
    expect(
      screen.getByText(
        "Files on older mail show up here once that mail is on this device.",
      ),
    ).toBeTruthy();
  });
});

function renderDialog({
  senders,
  checkFits = () => undefined,
}: {
  senders: Array<{ email: string; label: string }>;
  checkFits?: () => string | undefined;
}) {
  const onAttach = vi.fn();
  const onOpenChange = vi.fn();
  const cache = new Map();
  const ui = (open: boolean) => (
    <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>
      <AttachFromMailDialog
        checkFits={checkFits}
        emailAccountId="a"
        onAttach={onAttach}
        onOpenChange={onOpenChange}
        open={open}
        senders={senders}
      />
    </SWRConfig>
  );
  const view = render(ui(true));
  return {
    onAttach,
    onOpenChange,
    rerender: (open: boolean) => view.rerender(ui(open)),
  };
}

function entry(
  filename: string,
  kind: FileEntry["kind"],
  messageId: string,
  from: string,
): FileEntry {
  return {
    accountId: "a",
    conversationId: `c-${messageId}`,
    messageId,
    subject: "Q3",
    from,
    receivedAtMs: Date.UTC(2026, 0, 2),
    copies: 1,
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
