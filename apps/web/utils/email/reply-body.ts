import prisma from "@/utils/prisma";
import { renderEmailTextWithSafeLinks } from "@/utils/email/render-safe-links";

// Reply bodies passed to the email providers are HTML-safe: untrusted text is
// escaped here, and only trusted signature HTML is appended after it.
export async function buildDraftReplyBody({
  text,
  emailAccountId,
}: {
  text: string;
  emailAccountId: string;
}): Promise<string> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      allowHiddenAiDraftLinks: true,
      signature: true,
    },
  });

  let body = renderEmailTextWithSafeLinks(text, {
    allowHiddenLinks: emailAccount?.allowHiddenAiDraftLinks ?? false,
  });

  if (emailAccount?.signature) {
    body = `${body}${SIGNATURE_SEPARATOR}${emailAccount.signature}`;
  }

  return body;
}

/**
 * A drafted reply's body without the signature `buildDraftReplyBody` ended
 * it with, for a composer that adds the signature itself. A body signed with
 * another signature is left as it is.
 */
export function withoutDraftReplySignature(
  body: string,
  signature: string | null | undefined,
) {
  const known = signature && normalizeLines(signature).trim();
  if (!known) return body;
  // Line endings and trailing space can differ between the stored body and
  // the signature as it is now; the words can't.
  const normalized = normalizeLines(body);
  const suffix = `${SIGNATURE_SEPARATOR}${known}`;
  return normalized.endsWith(suffix)
    ? normalized.slice(0, -suffix.length).trimEnd()
    : body;
}

function normalizeLines(text: string) {
  return text.replace(/\r\n?/g, "\n").trimEnd();
}

const SIGNATURE_SEPARATOR = "\n\n";
