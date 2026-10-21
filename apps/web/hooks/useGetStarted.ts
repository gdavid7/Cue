import useSWR from "swr";
import type { GetStartedResponse } from "@/app/api/user/get-started/route";

export const GET_STARTED_KEY = "/api/user/get-started";

export function useGetStarted(enabled = true) {
  return useSWR<GetStartedResponse>(enabled ? GET_STARTED_KEY : null);
}
