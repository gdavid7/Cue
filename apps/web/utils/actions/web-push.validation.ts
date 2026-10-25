import { z } from "zod";

const quietUntilMs = z.number().int().positive().nullable();

// The server posts to whatever endpoint a browser hands it, so only the push
// services browsers actually use are accepted.
const PUSH_SERVICE_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export const saveWebPushSubscriptionBody = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine(isBrowserPushServiceEndpoint, "Unsupported push service"),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(128),
  }),
  mode: z.enum(["important", "all"]),
  // This browser's pause, in epoch milliseconds; null when it isn't paused.
  quietUntil: quietUntilMs.default(null),
});
export type SaveWebPushSubscriptionBody = z.infer<
  typeof saveWebPushSubscriptionBody
>;

export const deleteWebPushSubscriptionBody = z.object({
  endpoint: z.string().min(1).max(2048),
});

export const setWebPushQuietUntilBody = z.object({
  endpoint: z.string().min(1).max(2048),
  // Null clears the pause.
  quietUntil: quietUntilMs,
});

function isBrowserPushServiceEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}
