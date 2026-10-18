import { isMicrosoftProvider } from "@/utils/email/provider-types";
import {
  GOOGLE_APP_UNVERIFIED,
  GOOGLE_WEEKLY_SIGN_IN_NOTE,
} from "@/utils/google-app-status";

export function mailEngineConnectionCopy(
  connection: "ready" | "offline" | "blocked_auth" | undefined,
  provider: string | undefined,
) {
  if (connection === "blocked_auth") {
    // Usually an expired sign-in (routine while Google's OAuth app is in
    // Testing), so this reads as a next step rather than an error.
    const isMicrosoft = isMicrosoftProvider(provider);
    return {
      title: `Sign in again to reconnect ${isMicrosoft ? "Outlook" : "Gmail"}`,
      description: `${isMicrosoft ? "Microsoft" : "Google"} signed Cue out, so new mail is paused. Your mail and settings are still here.${isMicrosoft || !GOOGLE_APP_UNVERIFIED ? "" : ` ${GOOGLE_WEEKLY_SIGN_IN_NOTE}`}`,
      action: "Sign in again",
    };
  }
  if (connection === "offline") {
    return {
      title: "Can't reach your mailbox right now.",
      description:
        "Showing the mail Cue already has. It catches up on its own.",
    };
  }
}
