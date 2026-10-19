import chunk from "lodash/chunk";
import { isBatchError, isDefined } from "@/utils/types";
import { getGoogleGmailBatchUrl } from "@/utils/gmail/oauth";
import { createScopedLogger } from "@/utils/logger";
import {
  admitGmailCall,
  currentGmailQuotaContext,
  gmailAccountForAccessToken,
  gmailRequestCost,
  noteGmailQuotaRefusal,
} from "@/utils/gmail/quota";
import {
  gmailInflightBatchLimit,
  withGmailInflightSlot,
} from "@/utils/gmail/inflight";
import { isRetryableError } from "@/utils/gmail/retry";

const logger = createScopedLogger("gmail/batch");

const BATCH_LIMIT = 100;

// Uses Gmail batch API to get multiple responses in one request
// https://developers.google.com/gmail/api/guides/batch
export async function getBatch(
  ids: string[],
  endpoint: string, // e.g. /gmail/v1/users/me/messages
  accessToken: string,
  queryString?: string,
) {
  if (!ids.length) return [];
  if (ids.length > BATCH_LIMIT) {
    throw new Error(
      `Request count exceeds the limit. Received: ${ids.length}, Limit: ${BATCH_LIMIT}`,
    );
  }

  // Gmail counts every request inside a batch toward the user's requests in
  // flight, so a set larger than one call may hold is sent as several batches
  // that each wait for their slots, and their answers are joined in order.
  const limit = gmailInflightBatchLimit(currentGmailQuotaContext().priority);
  const parts = await Promise.all(
    chunk(ids, limit).map((idsChunk) =>
      sendBatch(idsChunk, endpoint, accessToken, queryString),
    ),
  );
  return parts.flat();
}

async function sendBatch(
  ids: string[],
  endpoint: string,
  accessToken: string,
  queryString: string | undefined,
) {
  let batchRequestBody = "";
  const query = queryString ? `?${queryString}` : "";
  for (const id of ids) {
    batchRequestBody += `--batch_boundary\nContent-Type: application/http\n\nGET ${endpoint}/${encodeURIComponent(id)}${query}\n\n`;
  }
  batchRequestBody += "--batch_boundary--";

  const emailAccountId = gmailAccountForAccessToken(accessToken);
  // Gmail charges every request inside a batch at its own method's cost.
  const ticket = await admitGmailCall({
    emailAccountId,
    cost: ids.length * gmailRequestCost("GET", `${endpoint}/id${query}`),
  });
  const { textRes, contentType } = await withGmailInflightSlot(
    { emailAccountId, priority: ticket.priority, weight: ids.length },
    async () => {
      const res = await fetch(getGoogleGmailBatchUrl(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "multipart/mixed; boundary=batch_boundary",
          "Accept-Encoding": "gzip",
          "User-Agent": "Cue (gzip)",
        },
        body: batchRequestBody,
      });
      return {
        textRes: await res.text(),
        contentType: res.headers.get("Content-Type"),
      };
    },
  );

  const batch = parseBatchResponse(textRes, contentType);
  // The refusal's own error says whether it was for volume, which decides
  // whether the account's budget is cut and a person's reads held.
  const refusal = batch.find(isQuotaRefusal);
  if (refusal && isBatchError(refusal))
    await noteGmailQuotaRefusal(ticket, refusal.error);

  return batch;
}

function isQuotaRefusal(item: unknown) {
  if (!isBatchError(item)) return false;
  const { code, message, errors } = item.error;
  return (
    (code === 403 || code === 429) &&
    isRetryableError({
      status: code,
      reason: errors?.[0]?.reason,
      errorMessage: message,
    }).isRateLimit
  );
}

function parseBatchResponse(batchResponse: string, contentType: string | null) {
  checkBatchResponseForError(batchResponse);

  // Extracting boundary from the Content-Type header
  const boundaryRegex = /boundary=(.*?)(;|$)/;
  const boundaryMatch = contentType?.match(boundaryRegex);
  const boundary = boundaryMatch ? boundaryMatch[1] : null;

  if (!boundary) {
    logger.error("No boundary found in response", { batchResponse });
    throw new Error("parseBatchResponse: No boundary found in response");
  }

  const parts = batchResponse.split(`--${boundary}`);

  // Process each part
  const decodedParts = parts.map((part) => {
    // Skip empty parts
    if (!part.trim()) return;

    // Find where the JSON part of the response starts
    const jsonStartIndex = part.indexOf("{");
    if (jsonStartIndex === -1) return; // Skip if no JSON data found

    // Extract the JSON string
    const jsonResponse = part.slice(jsonStartIndex);

    // Parse the JSON string
    try {
      const data = JSON.parse(jsonResponse);

      return data;
    } catch (error) {
      logger.error("Error parsing JSON", { error });
    }
  });

  return decodedParts.filter(isDefined);
}

function checkBatchResponseForError(batchResponse: string) {
  try {
    const jsonResponse = JSON.parse(batchResponse);

    if (jsonResponse.error) {
      throw new Error(
        "parseBatchResponse: Error in batch response",
        jsonResponse.error,
      );
    }
  } catch {
    // not json. skipping
  }
}
