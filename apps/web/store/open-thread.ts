import { atom } from "jotai";

/**
 * The thread open in the mail reader, and its latest message once loaded, so
 * the assistant chat can tell which email the user means by "this one".
 */
export const openThreadAtom = atom<{
  emailAccountId: string;
  threadId: string;
  messageId?: string;
} | null>(null);
