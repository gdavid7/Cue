"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { toastError } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { chatMessagesKey } from "@/hooks/useChatMessages";
import { useChat } from "@/providers/ChatProvider";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  cancelAssistantMatchingAction,
  confirmAssistantMatchingAction,
} from "@/utils/actions/assistant-chat";
import { toMatchingBulkAction } from "@/utils/ai/assistant/matching-query-actions";
import { getActionErrorMessage } from "@/utils/error";
import { followMatchingJobs } from "@/components/mail-bulk/follow-matching-jobs";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";

export function CountEmailsResult({ output }: { output: unknown }) {
  const value = asRecord(output);
  const total = typeof value?.total === "number" ? value.total : null;
  if (total === null) return null;
  const exact = value?.exact !== false;
  return (
    <div className="text-xs text-muted-foreground">
      {exact ? "Counted" : "Counted at least"} {formatCount(total)}{" "}
      {total === 1 ? "email" : "emails"}
    </div>
  );
}

/**
 * manageInbox over everything a search matches: the count, waiting for the
 * user's Confirm, which starts the inbox's select-all job (its progress, Stop
 * and Undo follow in the inbox's own toast), or what became of it.
 */
export function ManageInboxQueryResult({
  input,
  output,
  chatMessageId,
  toolCallId,
  disableConfirm,
}: {
  input: unknown;
  output: unknown;
  chatMessageId: string;
  toolCallId: string;
  disableConfirm: boolean;
}) {
  const { emailAccountId } = useAccount();
  const { chatId } = useChat();
  const { mutate } = useSWRConfig();
  const [answer, setAnswer] = useState<
    "confirming" | "cancelling" | "started" | "cancelled" | null
  >(null);
  const value = asRecord(output);
  const inputValue = asRecord(input);
  const query = typeof inputValue?.query === "string" ? inputValue.query : "";
  const conversations =
    typeof value?.conversations === "number" ? value.conversations : null;
  const confirmToken =
    typeof value?.confirmToken === "string" ? value.confirmToken : null;
  const status = answer ?? value?.status;

  const refreshChat = () => {
    if (chatId) mutate(chatMessagesKey(chatId));
  };

  const confirm = async () => {
    const action = toMatchingBulkAction(inputValue?.action, inputValue?.read);
    if (!chatId || !confirmToken || !action) return;
    setAnswer("confirming");
    const result = await confirmAssistantMatchingAction(emailAccountId, {
      chatId,
      chatMessageId,
      toolCallId,
      confirmToken,
      query,
    });
    const jobs = result?.data?.jobs;
    if (!jobs?.length) {
      setAnswer(null);
      toastError({ description: getActionErrorMessage(result ?? {}) });
      return;
    }
    setAnswer("started");
    refreshChat();
    // One job per account the search covered, followed together.
    const accountIds = jobs.map((job) => job.emailAccountId);
    followMatchingJobs({
      jobs: jobs.map((job) => ({
        accountId: job.emailAccountId,
        jobId: job.jobId,
      })),
      action,
      // The mail list follows the local store, which this brings up to date.
      onFinished: () => {
        getActiveMailClient()
          ?.requestSync(accountIds)
          .catch(() => undefined);
      },
    }).catch(() => undefined);
  };

  const cancel = async () => {
    if (!chatId || !confirmToken) return;
    setAnswer("cancelling");
    const result = await cancelAssistantMatchingAction(emailAccountId, {
      chatId,
      chatMessageId,
      toolCallId,
      confirmToken,
    });
    if (result?.serverError || result?.validationErrors) {
      setAnswer(null);
      toastError({ description: getActionErrorMessage(result) });
      // Confirm may have won in another tab; show what the chat recorded.
      refreshChat();
      return;
    }
    setAnswer("cancelled");
    refreshChat();
  };

  if (status === "nothing_to_change")
    return <Note text="Nothing matched, so nothing changed." />;
  if (status === "cancelled")
    return <Note text="Cancelled. Nothing changed." />;
  if (status === "started")
    return (
      <Note
        text={
          conversations === null
            ? "Started on every matching conversation."
            : `Started on ${conversationCount(conversations)}.`
        }
      />
    );

  const countText = `${conversations === null ? "Some" : formatCount(conversations)}${value?.atLeast ? "+" : ""} ${conversations === 1 ? "conversation matches" : "conversations match"}. Nothing has changed yet.`;
  if (!confirmToken) return <Note text={countText} />;
  const busy = status === "confirming" || status === "cancelling";
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="text-sm">{countText}</div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={confirm}
          disabled={disableConfirm || busy}
          loading={status === "confirming"}
        >
          Confirm
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={cancel}
          disabled={disableConfirm || busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function isManageInboxQueryOutput(output: unknown) {
  const status = asRecord(output)?.status;
  return (
    status === "needs_confirmation" ||
    status === "nothing_to_change" ||
    status === "started" ||
    status === "cancelled"
  );
}

function Note({ text }: { text: string }) {
  return <div className="text-xs text-muted-foreground">{text}</div>;
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function conversationCount(count: number) {
  return `${formatCount(count)} ${count === 1 ? "conversation" : "conversations"}`;
}

function formatCount(count: number) {
  return count.toLocaleString("en-US");
}
