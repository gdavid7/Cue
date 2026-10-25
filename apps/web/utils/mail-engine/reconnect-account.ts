import { toastError } from "@/components/Toast";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import { redirectToSafeUrl } from "@/utils/redirect";

/** Sends the user through sign-in again for an account the provider signed out. */
export function reconnectMailAccount({
  emailAccountId,
  provider,
}: {
  emailAccountId: string;
  provider: string | undefined;
}) {
  return getAccountLinkingUrl(
    isMicrosoftProvider(provider) ? "microsoft" : "google",
    { reconnectEmailAccountId: emailAccountId },
  )
    .then((url) => redirectToSafeUrl(url, { allowExternal: true }))
    .catch((error: unknown) => {
      toastError({
        title: "Couldn't start reconnecting",
        description:
          error instanceof Error
            ? error.message
            : "Check your connection and try again.",
      });
    });
}
