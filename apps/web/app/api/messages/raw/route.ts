import { NextResponse } from "next/server";
import { rawMessageQuery } from "@/app/api/messages/validation";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { createEmailProvider } from "@/utils/email/provider";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export const GET = withAuth("messages/raw", async (request) => {
  const { searchParams } = new URL(request.url);
  // Opened in a new tab or saved as a file, so the browser can't send the
  // account header that fetch would.
  const emailAccountId =
    request.headers.get(EMAIL_ACCOUNT_HEADER) ??
    searchParams.get("emailAccountId");
  if (!emailAccountId) {
    return NextResponse.json(
      { error: "Email account ID is required" },
      { status: 400 },
    );
  }
  const query = rawMessageQuery.parse({
    messageId: searchParams.get("messageId"),
    download: searchParams.get("download"),
  });
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, userId: request.auth.userId },
    select: { id: true, account: { select: { provider: true } } },
  });
  if (!emailAccount) {
    return NextResponse.json({ error: "Invalid account ID" }, { status: 403 });
  }
  const emailProvider = await createEmailProvider({
    emailAccountId: emailAccount.id,
    provider: emailAccount.account.provider,
    logger: request.logger,
  });
  const raw = await emailProvider.getRawMessage(query.messageId);

  // The message is untrusted: shown as plain text in a sandbox, never rendered.
  return new NextResponse(new Uint8Array(raw), {
    headers: {
      "Content-Type": query.download
        ? "message/rfc822"
        : "text/plain; charset=utf-8",
      "Content-Disposition": query.download
        ? 'attachment; filename="message.eml"'
        : "inline",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
