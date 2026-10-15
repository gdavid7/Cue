"use client";

import type React from "react";
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
import { MailEngineRuntime } from "@/utils/mail-engine/MailEngineHost";

export function AppProviders(props: {
  children: React.ReactNode;
  accounts: ServerEmailAccount[];
}) {
  return (
    // JS-driven animations follow the OS "reduce motion" setting, as CSS does.
    <MotionConfig reducedMotion="user">
      <Provider store={jotaiStore}>
        <EmailAccountProvider accounts={props.accounts}>
          <SWRProvider>
            <StatLoaderProvider>
              <ChatProvider>
                <MailEngineRuntime>
                  <ComposeModalProvider>{props.children}</ComposeModalProvider>
                </MailEngineRuntime>
              </ChatProvider>
            </StatLoaderProvider>
          </SWRProvider>
        </EmailAccountProvider>
      </Provider>
    </MotionConfig>
  );
}
