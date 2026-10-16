import type { ComposeAssistBody } from "@/app/api/ai/compose-assist/validation";
import { fetchWithAccount } from "@/utils/fetch";

const FAILED_MESSAGE = "Cue couldn't write a suggestion. Try again.";
const OFFLINE_MESSAGE =
  "Cue couldn't be reached. Check your connection and try again.";

/**
 * Streams Cue's text for a compose request, handing each piece to onText as
 * it arrives. Rejects with a message fit to show, or with the AbortError
 * when the signal stops it.
 */
export async function streamComposeAssist({
  emailAccountId,
  body,
  signal,
  onText,
}: {
  emailAccountId: string;
  body: ComposeAssistBody;
  signal: AbortSignal;
  onText: (text: string) => void;
}) {
  let response: Response;
  try {
    response = await fetchWithAccount({
      url: "/api/ai/compose-assist",
      emailAccountId,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(OFFLINE_MESSAGE);
  }

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(
      data?.isKnownError && typeof data.error === "string"
        ? data.error
        : FAILED_MESSAGE,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) onText(text);
    }
    const rest = decoder.decode();
    if (rest) onText(rest);
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(FAILED_MESSAGE);
  }
}
