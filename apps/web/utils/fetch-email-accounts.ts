import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { swrFetcher } from "@/providers/swr-fetcher";

export const EMAIL_ACCOUNTS_KEY = "/api/user/email-accounts";

let inflight: Promise<GetEmailAccountsResponse> | null = null;
let inflightController: AbortController | null = null;
let stopped = false;
const listeners = new Set<(data: GetEmailAccountsResponse) => void>();

export function fetchEmailAccounts(): Promise<GetEmailAccountsResponse> {
  if (stopped) return leaving();
  if (!inflight) {
    const controller = new AbortController();
    inflightController = controller;
    inflight = (
      swrFetcher(EMAIL_ACCOUNTS_KEY, {
        signal: controller.signal,
      }) as Promise<GetEmailAccountsResponse>
    )
      .then((data) => {
        for (const listener of listeners) listener(data);
        return data;
      })
      .catch((error) => {
        if (controller.signal.aborted) return leaving();
        throw error;
      })
      .finally(() => {
        inflight = null;
        inflightController = null;
      });
  }

  return inflight;
}

/**
 * Sign-out has started. The session is about to end, so a request still on
 * its way would come back 401 and be reported as an error; cancel it and send
 * no more while the page leaves.
 */
export function stopEmailAccountsFetches() {
  stopped = true;
  inflightController?.abort();
}

export function subscribeEmailAccounts(
  listener: (data: GetEmailAccountsResponse) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetEmailAccountsInflight() {
  inflight = null;
  inflightController = null;
  stopped = false;
}

/** Never settles: the page is leaving, so there is nothing to report. */
function leaving() {
  return new Promise<GetEmailAccountsResponse>(() => {});
}
