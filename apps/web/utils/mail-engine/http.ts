import type { MailHttpRequestFn } from "@inboxzero/mail-core/protocol/backend-adapter";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { isSessionExpiredErrorBody } from "@/utils/session-expired";
import { fetchWithSessionRetry } from "@/utils/session-refresh";
import { isSigningOut } from "@/utils/signing-out";

/**
 * onSessionExpired runs where the request ran, which may be a worker with no
 * page to redirect, so the engine's host decides how to reach the page.
 */
export function createMailHttpRequest(
  accountId: string,
  onSessionExpired: () => void,
): MailHttpRequestFn {
  return async ({ method, path, body, signal, accept }) => {
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
      onSessionExpired();
      return { status: response.status, json, sessionExpired: true };
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
