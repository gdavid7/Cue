"use client";

import { useEffect } from "react";
import { Crisp } from "crisp-sdk-web";
import { env } from "@/env";

let isSupportChatConfigured = false;

export const isSupportChatAvailable = Boolean(env.NEXT_PUBLIC_CRISP_WEBSITE_ID);

/**
 * Loads the support chat only when someone asks for it, so its third-party
 * script and socket stay off every other page load. The launcher bubble hides
 * again once the chat is closed.
 */
export function openSupportChat(userEmail?: string | null) {
  if (!env.NEXT_PUBLIC_CRISP_WEBSITE_ID) return;
  if (!isSupportChatConfigured) {
    Crisp.configure(env.NEXT_PUBLIC_CRISP_WEBSITE_ID);
    Crisp.chat.onChatClosed(() => Crisp.chat.hide());
    isSupportChatConfigured = true;
  }
  if (userEmail) Crisp.user.setEmail(userEmail);
  Crisp.chat.show();
  Crisp.chat.open();
}

// This is used to show the Crisp chat when the user is logged out, and auto opens to help the user
export const CrispChatLoggedOutVisible = () => {
  useEffect(() => {
    if (!env.NEXT_PUBLIC_CRISP_WEBSITE_ID) return;
    Crisp.configure(env.NEXT_PUBLIC_CRISP_WEBSITE_ID);
  }, []);

  return null;
};
