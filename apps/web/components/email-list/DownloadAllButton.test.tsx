// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadAllButton } from "@/components/email-list/DownloadAllButton";
import type { ThreadMessage } from "@/components/email-list/types";

const mocks = vi.hoisted(() => ({
  emailAccountId: "account-1" as string | null,
  fetchAttachment: vi.fn(),
  saveBlob: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: mocks.emailAccountId }),
}));
vi.mock("@/components/Toast", () => ({
  toastError: mocks.toastError,
  toastInfo: mocks.toastInfo,
}));
vi.mock("@/utils/attachments/download", () => ({
  fetchAttachment: mocks.fetchAttachment,
  getAttachmentUrl: ({ attachmentId }: { attachmentId: string }) =>
    `/attachment/${attachmentId}`,
  saveBlob: mocks.saveBlob,
}));

// fflate's workers don't exist under jsdom; the archive itself is covered in
// download-all.test.ts.
vi.mock("@/utils/attachments/download-all", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/utils/attachments/download-all")
  >()),
  zipAttachments: async () => new Blob(["zip"], { type: "application/zip" }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.emailAccountId = "account-1";
});

describe("DownloadAllButton visibility", () => {
  it("is hidden for a message with no attachments", () => {
    render(<DownloadAllButton message={message([])} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is hidden for a single attachment", () => {
    render(<DownloadAllButton message={message(["a.pdf"])} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the count from two attachments up", () => {
    render(<DownloadAllButton message={message(["a.pdf", "b.png"])} />);
    expect(
      screen.getByRole("button", { name: "Download all (2)" }),
    ).toBeTruthy();
  });

  it("is hidden when there is no account to fetch with", () => {
    mocks.emailAccountId = null;
    render(<DownloadAllButton message={message(["a.pdf", "b.png"])} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("DownloadAllButton click", () => {
  it("saves one zip named after the subject", async () => {
    mocks.fetchAttachment.mockResolvedValue(fakeBlob());
    render(<DownloadAllButton message={message(["a.pdf", "a.pdf"])} />);

    fireEvent.click(screen.getByRole("button", { name: "Download all (2)" }));

    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledTimes(1));
    expect(mocks.saveBlob.mock.calls[0]?.[1]).toBe(
      "Quarterly plan attachments.zip",
    );
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("downloads what worked and says what did not", async () => {
    mocks.fetchAttachment
      .mockResolvedValueOnce(fakeBlob())
      .mockRejectedValueOnce(new Error("boom"));
    render(<DownloadAllButton message={message(["a.pdf", "b.png"])} />);

    fireEvent.click(screen.getByRole("button", { name: "Download all (2)" }));

    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledTimes(1));
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Downloaded 1 of 2 attachments" }),
    );
  });

  it("shows an error and saves nothing when every download fails", async () => {
    mocks.fetchAttachment.mockRejectedValue(new Error("boom"));
    render(<DownloadAllButton message={message(["a.pdf", "b.png"])} />);

    fireEvent.click(screen.getByRole("button", { name: "Download all (2)" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.saveBlob).not.toHaveBeenCalled();
  });

  it("reports files skipped for the size cap without fetching them", async () => {
    mocks.fetchAttachment.mockResolvedValue(fakeBlob());
    render(
      <DownloadAllButton
        message={message(["a.pdf", "huge.bin", "c.png"], {
          "huge.bin": 200 * 1024 * 1024,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Download all (3)" }));

    await waitFor(() => expect(mocks.saveBlob).toHaveBeenCalledTimes(1));
    expect(mocks.fetchAttachment).toHaveBeenCalledTimes(2);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Downloaded 2 of 3 attachments",
        description: expect.stringContaining("1 skipped"),
      }),
    );
  });

  it("is disabled while the download is pending", async () => {
    mocks.fetchAttachment.mockReturnValue(new Promise(() => {}));
    render(<DownloadAllButton message={message(["a.pdf", "b.png"])} />);

    fireEvent.click(screen.getByRole("button", { name: "Download all (2)" }));

    const pending = await screen.findByRole("button", { name: /Zipping/ });
    expect(pending.hasAttribute("disabled")).toBe(true);
    expect(pending.getAttribute("aria-busy")).toBe("true");
  });
});

function message(
  filenames: string[],
  sizes: Record<string, number> = {},
): ThreadMessage {
  return {
    id: "message-1",
    headers: { subject: "Quarterly plan" },
    attachments: filenames.map((filename, index) => ({
      attachmentId: `att-${index}`,
      filename,
      mimeType: "application/octet-stream",
      size: sizes[filename] ?? 1024,
      headers: {},
    })),
  } as unknown as ThreadMessage;
}

// jsdom's Blob has no arrayBuffer().
function fakeBlob() {
  return { arrayBuffer: async () => new ArrayBuffer(5) } as unknown as Blob;
}
