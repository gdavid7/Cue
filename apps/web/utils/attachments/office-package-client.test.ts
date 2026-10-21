import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficePackageResult } from "@/utils/attachments/office-package";
import { readOfficePackageInWorker } from "@/utils/attachments/office-package-client";

const DOCX = "__tests__/playwright/emulated/mail/fixtures/planning-notes.docx";

class FakeWorker {
  static created: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  posted: { message: unknown; transfer: Transferable[] }[] = [];
  terminated = false;
  constructor() {
    FakeWorker.created.push(this);
  }
  postMessage(message: unknown, transfer: Transferable[]) {
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: OfficePackageResult) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

describe("readOfficePackageInWorker", () => {
  beforeEach(() => {
    FakeWorker.created = [];
    vi.stubGlobal("Worker", FakeWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("transfers the bytes to the worker and returns its answer", async () => {
    const bytes = new ArrayBuffer(8);
    const reading = readOfficePackageInWorker(bytes);
    const [worker] = FakeWorker.created;

    expect(worker.posted).toEqual([{ message: bytes, transfer: [bytes] }]);
    const repacked = { package: new Uint8Array([1, 2, 3]) };
    worker.reply(repacked);

    expect(await reading).toEqual(repacked);
    expect(worker.terminated).toBe(true);
  });

  it("terminates the worker when the preview closes", async () => {
    const controller = new AbortController();
    const reading = readOfficePackageInWorker(
      new ArrayBuffer(8),
      controller.signal,
    );
    const [worker] = FakeWorker.created;

    controller.abort();

    await expect(reading).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminated).toBe(true);
  });

  it("starts no worker for a preview already closed", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      readOfficePackageInWorker(new ArrayBuffer(8), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeWorker.created).toEqual([]);
  });

  it.each([
    "onerror",
    "onmessageerror",
  ] as const)("treats a worker %s as an invalid package", async (handler) => {
    const reading = readOfficePackageInWorker(new ArrayBuffer(8));
    const [worker] = FakeWorker.created;

    worker[handler]?.(new Event("error"));

    expect(await reading).toEqual({ refused: "invalid" });
    expect(worker.terminated).toBe(true);
  });
});

describe("office package worker", () => {
  const posted: { message: OfficePackageResult; transfer: Transferable[] }[] =
    [];
  const scope: {
    onmessage?: (event: MessageEvent<ArrayBuffer>) => Promise<void>;
    postMessage: (
      message: OfficePackageResult,
      options: { transfer: Transferable[] },
    ) => void;
  } = {
    postMessage: (message, { transfer }) => posted.push({ message, transfer }),
  };

  beforeEach(async () => {
    posted.length = 0;
    vi.stubGlobal("self", scope);
    await import("@/utils/attachments/office-package-worker");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends back the repacked package without copying it", async () => {
    const original = new Uint8Array(readFileSync(DOCX));

    await scope.onmessage?.(
      new MessageEvent("message", { data: original.slice().buffer }),
    );

    const [{ message, transfer }] = posted;
    if (!("package" in message)) throw new Error("refused a real document");
    expect(unzipSync(message.package)).toEqual(unzipSync(original));
    expect(transfer).toEqual([message.package.buffer]);
  });

  it("applies the same limits as on the page", async () => {
    const bomb = zipSync({
      "word/document.xml": new Uint8Array(2 * 1024 * 1024),
    });

    await scope.onmessage?.(
      new MessageEvent("message", { data: bomb.buffer as ArrayBuffer }),
    );

    expect(posted).toEqual([
      { message: { refused: "tooLarge" }, transfer: [] },
    ]);
  });
});
