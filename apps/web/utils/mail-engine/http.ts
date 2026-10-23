import type { MailHttpRequestFn } from "@inboxzero/mail-core/protocol/backend-adapter";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { isSessionExpiredErrorBody } from "@/utils/session-expired";
import {
  fetchWithSessionRetry,
  isAnsweredWhileStopped,
  sessionStopReason,
} from "@/utils/session-refresh";
import { isSigningOut } from "@/utils/signing-out";
import {
  isReconnectRequired,
  isReconnectRequiredBody,
  noteReconnectRequired,
  reconnectRequiredBody,
} from "@/utils/reconnect-required";

/**
 * onSessionExpired runs where the request ran, which may be a worker with no
 * page to redirect, so the engine's host decides how to reach the page. It
 * runs once requests stop, with why; not for the 401s answered here while
 * stopped, nor when a refresh could not tell whether the session is gone.
 */
export function createMailHttpRequest(
  accountId: string,
  onSessionExpired: (reason: "signed-out" | "rejected") => void,
): MailHttpRequestFn {
  return async ({ method, path, body, signal, accept }) => {
    // Answered as the server would, which the engine reads as a lost grant
    // and shows its reconnect prompt, without asking again.
    if (isReconnectRequired(accountId, path)) {
      return { status: 401, json: reconnectRequiredBody() };
    }
    const encoded = encodeRequestBody(body);
    const response = await fetchWithSessionRetry(path, {
      method,
      signal,
      credentials: "include",
      headers: {
        accept:
          accept === "bytes" ? "application/octet-stream" : "application/json",
        [EMAIL_ACCOUNT_HEADER]: accountId,
        ...encoded.headers,
      },
      body: encoded.body,
    });
    if (accept === "bytes" && response.ok) {
      const sizeHeader = response.headers.get("content-length");
      return {
        status: response.status,
        json: null,
        bytes: iterableFromStream(response.body),
        sizeBytes:
          sizeHeader && /^\d+$/.test(sizeHeader) ? Number(sizeHeader) : null,
      };
    }
    const json = await response.json().catch(() => null);
    if (
      response.status === 401 &&
      !isSigningOut() &&
      isSessionExpiredErrorBody(json)
    ) {
      const reason = isAnsweredWhileStopped(response)
        ? undefined
        : sessionStopReason();
      if (reason) onSessionExpired(reason);
      return { status: response.status, json, sessionExpired: true };
    }
    if (response.status === 401 && isReconnectRequiredBody(json)) {
      noteReconnectRequired(accountId, path);
    }
    return { status: response.status, json };
  };
}

async function* iterableFromStream(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function encodeRequestBody(body: unknown): {
  headers: Record<string, string>;
  body?: BodyInit;
} {
  if (body === undefined) return { headers: {} };
  return {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
