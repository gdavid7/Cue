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
  const suffix = signature ? `${SIGNATURE_SEPARATOR}${signature}` : "";
  return suffix && body.endsWith(suffix) ? body.slice(0, -suffix.length) : body;
}

const SIGNATURE_SEPARATOR = "\n\n";
