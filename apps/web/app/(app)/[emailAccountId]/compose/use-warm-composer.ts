"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import type { GetSignatureResponse } from "@/app/api/user/signature/route";
import { preloadComposeEmailForm } from "@/app/(app)/[emailAccountId]/compose/ComposeEmailFormLazy";
import type { EmailAccountFullResponse } from "@/app/api/user/email-account/route";
import { useAccount } from "@/providers/EmailAccountProvider";
import { afterFirstMailList } from "@/utils/mail-engine/first-mail-list";
import { getAccountScopedKey } from "@/utils/swr";

const WARM_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
} as const;

/**
 * Gets the composer ready once the mail list is up and the page is idle: its code, the account and
 * the signature it waits on. The first signature read imports it from Gmail,
 * which can take seconds, so it runs here rather than when "c" is pressed.
 */
export function useWarmComposer() {
  const { emailAccountId } = useAccount();
  const [warm, setWarm] = useState(false);
  useEffect(
    () =>
      afterFirstMailList(() => {
        preloadComposeEmailForm();
        setWarm(true);
      }),
    [],
  );
  // The composer reads these same keys, so it opens on them at once.
  useSWR<GetSignatureResponse>(
    warm ? getAccountScopedKey("/api/user/signature", emailAccountId) : null,
    WARM_OPTIONS,
  );
  useSWR<EmailAccountFullResponse>(
    warm
      ? getAccountScopedKey("/api/user/email-account", emailAccountId)
      : null,
    WARM_OPTIONS,
  );
}
