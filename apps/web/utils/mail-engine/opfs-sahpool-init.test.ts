import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_ENGINE_OPFS_DIRECTORY } from "./opfs-mailbox";
import { MAIL_ENGINE_SAH_POOL_RETRY } from "./wasm-sqlite";

// Exercises the installed @sqlite.org/sqlite-wasm, including its pnpm patch.
describe("OPFS SAH pool install", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leaves the mailbox files in place when a handle cannot be opened", async () => {
    // sqlite-wasm reports the failed handle on the console.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sqlite = await initBrowserSqlite();
    const root = new FakeDirectory("");
    const opaque = root
      .directory(MAIL_ENGINE_OPFS_DIRECTORY)
      .directory(".opaque");
    opaque.entries.set("slot-1", new FakeFile("slot-1", true));
    vi.stubGlobal("FileSystemHandle", FakeHandle);
    vi.stubGlobal("FileSystemDirectoryHandle", FakeDirectory);
    vi.stubGlobal("FileSystemFileHandle", FakeFile);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => root },
    });

    await expect(
      sqlite.installOpfsSAHPoolVfs({
        name: `mail-engine-${crypto.randomUUID()}`,
        directory: MAIL_ENGINE_OPFS_DIRECTORY,
      }),
    ).rejects.toThrow("UnknownError");

    expect(root.entries.has(MAIL_ENGINE_OPFS_DIRECTORY)).toBe(true);
    expect([...opaque.entries.keys()]).toEqual(["slot-1"]);
  });

  it("installs again in the same context once the handle opens", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sqlite = await initBrowserSqlite();
    const root = new FakeDirectory("");
    const opaque = root
      .directory(MAIL_ENGINE_OPFS_DIRECTORY)
      .directory(".opaque");
    const slot = new FakeFile("slot-1", true);
    opaque.entries.set("slot-1", slot);
    vi.stubGlobal("FileSystemHandle", FakeHandle);
    vi.stubGlobal("FileSystemDirectoryHandle", FakeDirectory);
    vi.stubGlobal("FileSystemFileHandle", FakeFile);
    vi.stubGlobal("navigator", {
      storage: { getDirectory: async () => root },
    });
    const options = {
      name: `mail-engine-${crypto.randomUUID()}`,
      directory: MAIL_ENGINE_OPFS_DIRECTORY,
      ...MAIL_ENGINE_SAH_POOL_RETRY,
    };
    await expect(sqlite.installOpfsSAHPoolVfs(options)).rejects.toThrow(
      "UnknownError",
    );
    slot.failsToOpen = false;

    const pool = await sqlite.installOpfsSAHPoolVfs(options);

    expect(pool.getCapacity()).toBe(1);
    expect([...opaque.entries.keys()]).toEqual(["slot-1"]);
  });
});

/**
 * Node resolves the package to its build without the SAH pool, so this loads
 * the browser build the app ships.
 */
async function initBrowserSqlite() {
  const packageDir = dirname(
    createRequire(import.meta.url).resolve(
      "@sqlite.org/sqlite-wasm/package.json",
    ),
  );
  const { default: init } = (await import(
    /* @vite-ignore */ pathToFileURL(join(packageDir, "dist/index.mjs")).href
  )) as typeof import("@sqlite.org/sqlite-wasm");
  const wasmBinary = await readFile(join(packageDir, "dist/sqlite3.wasm"));
  return (init as (options: unknown) => ReturnType<typeof init>)({
    wasmBinary,
  });
}

class FakeHandle {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

class FakeFile extends FakeHandle {
  readonly kind = "file";
  failsToOpen: boolean;
  constructor(name: string, failsToOpen = false) {
    super(name);
    this.failsToOpen = failsToOpen;
  }
  async createSyncAccessHandle() {
    // Not the lock error (NoModificationAllowedError) a held file reports.
    if (this.failsToOpen) {
      throw new DOMException("UnknownError: could not open", "UnknownError");
    }
    return {
      close: () => undefined,
      read: () => 0,
      write: () => 0,
      truncate: () => undefined,
      getSize: () => 0,
      flush: () => undefined,
    };
  }
}

class FakeDirectory extends FakeHandle {
  readonly kind = "directory";
  readonly entries = new Map<string, FakeDirectory | FakeFile>();

  directory(name: string) {
    const existing = this.entries.get(name);
    if (existing instanceof FakeDirectory) return existing;
    const created = new FakeDirectory(name);
    this.entries.set(name, created);
    return created;
  }

  async getDirectoryHandle(name: string) {
    return this.directory(name);
  }

  async getFileHandle(name: string) {
    const existing = this.entries.get(name);
    if (existing instanceof FakeFile) return existing;
    const created = new FakeFile(name);
    this.entries.set(name, created);
    return created;
  }

  async removeEntry(name: string) {
    this.entries.delete(name);
  }

  async *[Symbol.asyncIterator]() {
    yield* this.entries.entries();
  }
}
