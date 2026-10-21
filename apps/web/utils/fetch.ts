import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { isSigningOut, withSigningOutSignal } from "@/utils/signing-out";

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
  // The page is leaving and the session is about to end, so a request would
  // only answer 401. Like swrFetcher, never settle: nobody should report it.
  if (isSigningOut()) return new Promise<Response>(() => {});

  const headers = new Headers(init?.headers);

  if (emailAccountId) {
    headers.set(EMAIL_ACCOUNT_HEADER, emailAccountId);
  }

  const newInit = {
    ...init,
    headers,
    signal: withSigningOutSignal(init?.signal),
  };

  try {
    return await fetch(url, newInit);
  } catch (error) {
    if (isSigningOut()) return new Promise<Response>(() => {});
    throw error;
  }
};
