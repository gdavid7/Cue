export function admissionRejectionCopy(code: string | undefined) {
  if (code === "queue_full") {
    return "Your earlier changes are still being saved to your mailbox. Try again in a moment.";
  }
  if (code === "too_large" || code === "storage_unavailable") {
    return "Your device is running out of storage, so this didn't go through. Free up some space, then try again.";
  }
}
