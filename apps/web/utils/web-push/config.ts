import { env } from "@/env";

/** Web push is off unless the server holds a full VAPID key pair. */
export function getWebPushVapidConfig() {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}
