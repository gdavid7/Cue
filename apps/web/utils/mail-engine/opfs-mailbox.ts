// Kept apart from the SQLite driver: sign-out and the login page wipe the
// local mailbox on every screen, and importing the driver for that would put
// sqlite-wasm in every page's first load.
export const MAIL_ENGINE_OPFS_DIRECTORY = ".mail-engine";

/** Resolves false when the mailbox is still on disk after every retry. */
export async function wipeOpfsMailEngine(): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    !("storage" in navigator) ||
    !("getDirectory" in navigator.storage)
  ) {
    return true;
  }
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    // Without OPFS access the engine could not have stored anything either.
    return true;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await root.removeEntry(MAIL_ENGINE_OPFS_DIRECTORY, { recursive: true });
      return true;
    } catch (error) {
      if (isMissingOpfsEntry(error)) return true;
      if (attempt === 7) return false;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
  return false;
}

function isMissingOpfsEntry(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotFoundError"
  );
}
