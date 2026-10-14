import { BRAND_NAME } from "@/utils/branding";

export const APPROVAL_LOGIN_PATH = "/login?from=approval";

export function getApprovalEmail({
  email,
  name,
  baseUrl,
  senderName,
}: {
  email: string;
  name?: string | null;
  baseUrl: string;
  senderName?: string | null;
}) {
  const firstName = name?.trim().split(/\s+/)[0] || "there";
  const loginUrl = new URL(APPROVAL_LOGIN_PATH, baseUrl).href;
  const body = [
    `Hi ${firstName},`,
    "",
    `Your request to try ${BRAND_NAME} was approved. Sign in with ${email}. Access is tied to that Google account and can't be shared or transferred.`,
    "",
    `Open ${BRAND_NAME}: ${loginUrl}`,
    "",
    `When you sign in, Google will ask to let ${BRAND_NAME} read and send mail and see your calendar. ${BRAND_NAME} uses that to sort what needs you and draft replies. It never moves or labels your Gmail, never sends without you, and never uses your mail to train AI.`,
    ...(senderName ? ["", `— ${senderName}`] : []),
  ].join("\n");

  return {
    subject: `You're in: your ${BRAND_NAME} access is ready`,
    body,
  };
}

export function getApprovalMailtoUrl(
  email: string,
  message: { subject: string; body: string },
) {
  const query = new URLSearchParams({
    subject: message.subject,
    body: message.body,
  })
    .toString()
    .replaceAll("+", "%20");
  return `mailto:${encodeURIComponent(email)}?${query}`;
}
