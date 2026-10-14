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
    body = `${body}\n\n${emailAccount.signature}`;
  }

  return body;
}
