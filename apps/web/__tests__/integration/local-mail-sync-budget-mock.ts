import type * as LocalMailSyncBudget from "@/utils/email/local-mail-sync-budget";

/**
 * vi.mock factory for "@/utils/email/local-mail-sync-budget" that runs every
 * reserved operation. The budget fails closed without Redis, which these
 * integration slices don't run, and pauses Gmail sync for a minute; its own
 * behavior is covered by utils/email/local-mail-sync-budget.test.ts.
 */
export async function passThroughLocalMailSyncBudget(
  importActual: () => Promise<typeof LocalMailSyncBudget>,
): Promise<typeof LocalMailSyncBudget> {
  return {
    ...(await importActual()),
    withLocalMailSyncBudget: (_input, operation) =>
      operation(new AbortController().signal, { nextAdmitAfterMs: null }),
    debitLocalMailSyncBudget: async () => undefined,
  };
}
