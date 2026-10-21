import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { withSigningOutSignal } from "@/utils/signing-out";

/**
 * A wrapper around the native fetch function that automatically adds the
 * EMAIL_ACCOUNT_HEADER if an emailAccountId is provided.
 */
export const fetchWithAccount = async ({
  url,
  emailAccountId,
  init,
}: {
  url: string | URL | Request;
  emailAccountId: string | null;
  init?: RequestInit;
}): Promise<Response> => {
  const headers = new Headers(init?.headers);

  if (emailAccountId) {
    headers.set(EMAIL_ACCOUNT_HEADER, emailAccountId);
  }

  // Once sign-out starts the signal is aborted, so this rejects with an
  // AbortError instead of sending a request that would answer 401.
  const newInit = {
    ...init,
    headers,
    signal: withSigningOutSignal(init?.signal),
  };

  return fetch(url, newInit);
};
