import { extractEmailAddresses } from "@/utils/email";
import type { GmailSignature } from "@/utils/gmail/signature-settings";

type ReplySourceHeaders = Partial<
  Record<"from" | "to" | "cc" | "delivered-to", string | null>
>;

/**
 * The From a reply carries, chosen the way Gmail does: the first of the
 * account's send-as addresses that the replied-to message came from (your own
 * sent mail or draft) or was sent to. Undefined leaves Gmail's default address.
 */
export function getGmailReplyFrom(
  headers: ReplySourceHeaders,
  sendAs: GmailSignature[],
): string | undefined {
  const sendable = sendAs.filter(
    (alias) =>
      !alias.verificationStatus || alias.verificationStatus === "accepted",
  );
  const byAddress = new Map(
    sendable.map((alias) => [alias.email.toLowerCase(), alias]),
  );

  for (const header of [
    headers.from,
    headers.to,
    headers.cc,
    headers["delivered-to"],
  ]) {
    for (const address of extractEmailAddresses(header ?? "")) {
      const alias = byAddress.get(address.toLowerCase());
      if (!alias) continue;
      if (alias.isDefault) return;
      // An alias without a name of its own goes out under the account's name.
      const name =
        alias.displayName ||
        sendable.find((other) => other.isDefault)?.displayName;
      return name
        ? `"${name.replace(/[\\"]/g, "\\$&")}" <${alias.email}>`
        : alias.email;
    }
  }
}
