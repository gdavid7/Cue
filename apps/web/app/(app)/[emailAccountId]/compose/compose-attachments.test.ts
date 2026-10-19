import { EMAIL_ATTACHMENT_LIMITS } from "@inboxzero/email-editor/core";
import { describe, expect, it } from "vitest";
import type { DraftAttachment } from "@/utils/email/types";
import {
  type ComposeAttachment,
  describeUnattachedFiles,
  fitComposeAttachments,
  getGmailAttachmentDraftSaveIntervalMs,
  mergeDraftAttachments,
  routeComposeFiles,
  toAttachmentReference,
} from "./compose-attachments";

describe("toAttachmentReference", () => {
  it("keeps only a reference to files already on the mailbox draft", () => {
    const stored = [
      attachment({
        id: "photo",
        status: "uploaded",
        draftAttachmentId: "graph-1",
        previewUrl: "blob:preview",
        managed: true,
        disposition: "inline",
        contentId: "photo@inboxzero.local",
      }),
      attachment({ id: "uploading", status: "uploading" }),
      attachment({ id: "failed", status: "failed", error: "Too large" }),
    ].flatMap(toAttachmentReference);

    expect(stored).toEqual([
      {
        id: "photo",
        filename: "photo.png",
        mimeType: "image/png",
        size: 10,
        disposition: "inline",
        contentId: "photo@inboxzero.local",
        draftAttachmentId: "graph-1",
      },
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/blob:|contentBase64/);
  });
});

describe("mergeDraftAttachments", () => {
  it("keeps the local id of a file Outlook gave its own id", () => {
    const merged = mergeDraftAttachments(
      [
        attachment({
          id: "local-1",
          status: "uploaded",
          draftAttachmentId: "graph-1",
        }),
      ],
      [listed({ id: "graph-1" })],
    );
    expect(merged).toEqual([
      expect.objectContaining({
        id: "local-1",
        draftAttachmentId: "graph-1",
        status: "uploaded",
      }),
    ]);
  });

  it("adds files the draft carries that the composer didn't attach", () => {
    const merged = mergeDraftAttachments(
      [],
      [listed({ id: "forwarded", filename: "report.pdf" })],
    );
    expect(merged).toEqual([
      expect.objectContaining({
        id: "forwarded",
        filename: "report.pdf",
        status: "uploaded",
      }),
    ]);
  });

  it("keeps files still uploading and drops ones no longer on the draft", () => {
    const merged = mergeDraftAttachments(
      [
        attachment({
          id: "gone",
          status: "uploaded",
          draftAttachmentId: "gone",
        }),
        attachment({ id: "pending", status: "uploading" }),
      ],
      [],
    );
    expect(merged.map((item) => item.id)).toEqual(["pending"]);
  });

  it("keeps an inline image's preview when Gmail renumbers it", () => {
    const merged = mergeDraftAttachments(
      [
        attachment({
          id: "photo",
          status: "uploaded",
          draftAttachmentId: "old-gmail-id",
          disposition: "inline",
          contentId: "photo@inboxzero.local",
          previewUrl: "blob:preview",
          managed: true,
        }),
      ],
      [
        listed({
          id: "new-id",
          disposition: "inline",
          contentId: "photo@inboxzero.local",
        }),
      ],
    );
    expect(merged).toEqual([
      expect.objectContaining({
        id: "photo",
        draftAttachmentId: "new-id",
        previewUrl: "blob:preview",
        managed: true,
      }),
    ]);
  });
});

function attachment(overrides: Partial<ComposeAttachment>): ComposeAttachment {
  return {
    id: "file",
    filename: "photo.png",
    mimeType: "image/png",
    size: 10,
    disposition: "attachment",
    status: "uploaded",
    ...overrides,
  };
}

function listed(overrides: Partial<DraftAttachment>): DraftAttachment {
  return {
    id: "file",
    filename: "photo.png",
    mimeType: "image/png",
    size: 10,
    disposition: "attachment",
    messageId: "message-1",
    providerAttachmentId: "provider-file",
    ...overrides,
  };
}

describe("routeComposeFiles", () => {
  const file = (name: string, type: string, size = 10) =>
    new File([new Uint8Array(size)], name, { type });

  it.each([
    ["a PDF", file("report.pdf", "application/pdf")],
    [
      "a Word document",
      file(
        "notes.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ],
    ["a zip archive", file("photos.zip", "application/zip")],
    ["a file with no type", file("data.bin", "")],
    [
      "an image mail clients can't show inline",
      file("photo.heic", "image/heic"),
    ],
    ["an SVG", file("logo.svg", "image/svg+xml")],
    [
      "an image too large to inline",
      file("scan.png", "image/png", EMAIL_ATTACHMENT_LIMITS.maxInlineBytes + 1),
    ],
  ])("attaches %s dropped into the message", (_, dropped) => {
    expect(
      routeComposeFiles([dropped], { into: "body", inlineCount: 0 }),
    ).toEqual({ inline: [], attachments: [dropped] });
  });

  it.each([
    ["PNG", "image/png"],
    ["JPEG", "image/jpeg"],
    ["GIF", "image/gif"],
    ["WebP", "image/webp"],
  ])("puts a %s dropped into the message inline", (_, type) => {
    const image = file("photo", type);
    expect(
      routeComposeFiles([image], { into: "body", inlineCount: 0 }),
    ).toEqual({
      inline: [image],
      attachments: [],
    });
  });

  it("attaches images dropped outside the message body", () => {
    const image = file("photo.png", "image/png");
    expect(
      routeComposeFiles([image], { into: "window", inlineCount: 0 }),
    ).toEqual({ inline: [], attachments: [image] });
  });

  it("splits a mixed drop and attaches images past the inline limit", () => {
    const pdf = file("report.pdf", "application/pdf");
    const first = file("first.png", "image/png");
    const second = file("second.png", "image/png");
    const inlineCount = EMAIL_ATTACHMENT_LIMITS.maxInlineFiles - 1;

    expect(
      routeComposeFiles([pdf, first, second], { into: "body", inlineCount }),
    ).toEqual({ inline: [first], attachments: [pdf, second] });
  });
});

describe("fitComposeAttachments", () => {
  const meta = (id: string, size: number) => ({
    id,
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    size,
    disposition: "attachment" as const,
  });

  it("attaches the files that fit and names the ones that don't", () => {
    const result = fitComposeAttachments({
      existing: [meta("on-draft", 10_000_000)],
      candidates: [
        meta("small", 4_000_000),
        meta("video", 15_000_000),
        meta("notes", 1_000_000),
      ],
      maxTotalBytes: 25_000_000,
    });

    expect(result.accepted.map(({ id }) => id)).toEqual(["small", "notes"]);
    expect(result.rejected.map(({ id }) => id)).toEqual(["video"]);
    expect(result.error).toBe(
      "Attachments can total up to 25 MB. These add up to 29 MB.",
    );
  });

  it("accepts everything within the limit", () => {
    expect(
      fitComposeAttachments({
        existing: [],
        candidates: [meta("a", 1), meta("b", 2)],
        maxTotalBytes: 25_000_000,
      }),
    ).toMatchObject({ rejected: [], error: undefined });
  });
});

describe("getGmailAttachmentDraftSaveIntervalMs", () => {
  // Each Gmail save re-reads and re-uploads every file on the draft.
  it.each([
    [0, 0],
    [100_000, 15_000],
    [3_000_000, 15_000],
    [10_000_000, 50_000],
    [25_000_000, 120_000],
  ])("spaces saves for %i attached bytes %i ms apart", (bytes, interval) => {
    expect(getGmailAttachmentDraftSaveIntervalMs(bytes)).toBe(interval);
  });
});

describe("describeUnattachedFiles", () => {
  const reason = "Attachments can total up to 25 MB. These add up to 30 MB.";

  it("names a single file that wasn't attached and why", () => {
    expect(describeUnattachedFiles([{ filename: "video.mp4" }], reason)).toBe(
      `video.mp4 wasn't attached. ${reason}`,
    );
  });

  it("names every file that wasn't attached", () => {
    expect(
      describeUnattachedFiles(
        [{ filename: "video.mp4" }, { filename: "photos.zip" }],
        reason,
      ),
    ).toBe(`2 files weren't attached (video.mp4, photos.zip). ${reason}`);
  });
});
