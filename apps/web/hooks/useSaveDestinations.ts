import useSWR from "swr";
import type { GetSaveDestinationsResponse } from "@/app/api/user/save-destinations/route";

/** Where the reader can send things from this account's email. */
export function useSaveDestinations(emailAccountId: string | null | undefined) {
  return useSWR<GetSaveDestinationsResponse>(
    emailAccountId ? ["/api/user/save-destinations", emailAccountId] : null,
    { revalidateOnFocus: false },
  );
}
