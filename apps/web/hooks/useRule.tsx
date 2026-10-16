import useSWR from "swr";
import type { RuleResponse } from "@/app/api/user/rules/[id]/route";
import { useAccount } from "@/providers/EmailAccountProvider";
import { getAccountScopedKey } from "@/utils/swr";

// Keyed by the account in scope: a rule card in a chat working in another
// account reads that account's rule, not the page's.
export function useRule(ruleId?: string | null) {
  const { emailAccountId } = useAccount();
  return useSWR<RuleResponse, { error: string }>(
    ruleId
      ? getAccountScopedKey(`/api/user/rules/${ruleId}`, emailAccountId)
      : null,
  );
}
