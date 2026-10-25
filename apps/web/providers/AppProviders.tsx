"use client";

import type React from "react";
import { useEffect } from "react";
import { Provider } from "jotai";
import { MotionConfig } from "motion/react";
import { ComposeModalProvider } from "@/providers/ComposeModalProvider";
import { jotaiStore } from "@/store";
import { ChatProvider } from "@/providers/ChatProvider";
import {
  EmailAccountProvider,
  type ServerEmailAccount,
} from "@/providers/EmailAccountProvider";
import { StatLoaderProvider } from "@/providers/StatLoaderProvider";
import { SWRProvider } from "@/providers/SWRProvider";
import { MailboxProvidersProvider } from "@/providers/MailboxProvidersProvider";
import type { MailboxProvider } from "@/utils/oauth/provider-config";
import { MailEngineRuntime } from "@/utils/mail-engine/MailEngineHost";
import { armSessionExpiredRedirect } from "@/utils/session-expired";

export function AppProviders(props: {
  children: React.ReactNode;
  accounts: ServerEmailAccount[];
  userId: string;
  enabledMailboxProviders: readonly MailboxProvider[];
}) {
  // The app layout only renders for a signed-in user, so a 401 from here on
  // means that session ended.
  useEffect(() => armSessionExpiredRedirect(props.userId), [props.userId]);

  return (
    // JS-driven animations follow the OS "reduce motion" setting, as CSS does.
    <MotionConfig reducedMotion="user">
      <Provider store={jotaiStore}>
        <MailboxProvidersProvider
          enabledProviders={props.enabledMailboxProviders}
        >
          <EmailAccountProvider accounts={props.accounts} userId={props.userId}>
            <SWRProvider>
              <StatLoaderProvider>
                <ChatProvider>
                  <MailEngineRuntime>
                    <ComposeModalProvider>
                      {props.children}
                    </ComposeModalProvider>
                  </MailEngineRuntime>
                </ChatProvider>
              </StatLoaderProvider>
            </SWRProvider>
          </EmailAccountProvider>
        </MailboxProvidersProvider>
      </Provider>
    </MotionConfig>
  );
}
