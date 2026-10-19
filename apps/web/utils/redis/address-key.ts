import { createHash } from "node:crypto";

/**
 * An email address as it may appear in a Redis key: hashed, so no key names
 * anyone (RD-3). Lowercased first, so one mailbox always maps to one key.
 */
export function hashAddressForKey(address: string) {
  return createHash("sha256")
    .update(address.trim().toLowerCase())
    .digest("hex");
}
