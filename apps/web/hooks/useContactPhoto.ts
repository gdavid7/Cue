import useSWR, { useSWRConfig } from "swr";
import type { ContactPhotosResponse } from "@/app/api/user/contacts/photos/route";
import { env } from "@/env";
import { createBrowserCache } from "@/utils/browser-cache";
import { canonicalizeEmailAddress } from "@/utils/email";

// Contact photos rarely change and sweeping the address book is expensive
// against the provider's per-user quota. The server keeps none of them
// (RD-3), so this browser keeps a complete sweep for a day.
const sweeps = createBrowserCache<ContactPhotosResponse["photos"]>({
  name: "contact-photos",
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 1,
});

export function useContactPhoto({
  email,
  emailAccountId,
}: {
  email: string | null | undefined;
  emailAccountId: string | null | undefined;
}) {
  const { fetcher } = useSWRConfig();
  // Every avatar shares one key, so a page full of senders costs one request.
  const { data } = useSWR<ContactPhotosResponse["photos"]>(
    env.NEXT_PUBLIC_CONTACTS_ENABLED && email && emailAccountId
      ? ["/api/user/contacts/photos", emailAccountId]
      : null,
    async (key: [string, string]) => {
      const [, accountId] = key;
      const kept = sweeps.get(accountId, "all");
      if (kept) return kept;
      if (!fetcher) throw new Error("SWR fetcher is not configured");
      const response = (await fetcher(key)) as ContactPhotosResponse;
      if (response.swept) sweeps.set(accountId, "all", response.photos);
      return response.photos;
    },
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  if (!email) return;

  return data?.[canonicalizeEmailAddress(email)];
}
