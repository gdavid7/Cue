import { z } from "zod";
import { isSafeExternalHttpUrl } from "@inboxzero/network/safe-url";
import { safeExternalFetch } from "@/utils/mcp/safe-fetch";

// Long enough for a slow school server, short enough to answer a form.
const VERIFY_TIMEOUT_MS = 8000;
const MAX_SAME_SITE_REDIRECTS = 3;
// A Canvas user record is a few hundred bytes; anything far bigger isn't one.
const MAX_RESPONSE_BYTES = 64 * 1024;

export type CanvasCheckFailure =
  | "rejected"
  | "not_canvas"
  | "unreachable"
  | "redirected";

export type CanvasCheck =
  | { ok: true; origin: string; user: { id: string; name: string } }
  | { ok: false; reason: CanvasCheckFailure };

type Fetch = (
  url: string,
  init: RequestInit & { headers: Record<string, string> },
) => Promise<Response>;

/**
 * The https origin of whatever Canvas address was pasted: the site, a course
 * page or the API root all become "https://canvas.school.edu". Null when it
 * isn't a web address.
 */
export function normalizeSiteAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // "canvas.school.edu:8443" has no scheme, though it reads like one
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) return null;
  // Canvas is served over https; an http address is the same site.
  return `https://${url.host}`;
}

/**
 * Asks Canvas who the token belongs to (`GET /api/v1/users/self`), so a
 * connection is saved only for a token Canvas accepts. Only public https
 * hosts are called. A redirect within the same origin is followed (a few
 * hops, all within one deadline); the token never follows one to another
 * site. The answer is read only up to the size of a user record.
 */
export async function verifyCanvasToken({
  address,
  token,
  fetch = canvasFetch,
}: {
  address: string;
  token: string;
  fetch?: Fetch;
}): Promise<CanvasCheck> {
  const origin = normalizeSiteAddress(address);
  if (!origin || !isSafeExternalHttpUrl(origin)) {
    return { ok: false, reason: "not_canvas" };
  }

  let url = `${origin}/api/v1/users/self`;
  let response: Response | undefined;
  const signal = AbortSignal.timeout(VERIFY_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_SAME_SITE_REDIRECTS; hop++) {
      response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        redirect: "manual",
        signal,
      });
      if (response.status < 300 || response.status >= 400) break;
      await response.body?.cancel().catch(() => null);
      const next = redirectTarget(response, url);
      // Same origin only: the token goes nowhere else
      if (!next || new URL(next).origin !== origin) {
        return { ok: false, reason: "redirected" };
      }
      url = next;
    }
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (!response) return { ok: false, reason: "unreachable" };

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "rejected" };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, reason: "redirected" };
  }
  if (response.status === 404) return { ok: false, reason: "not_canvas" };
  if (!response.ok) return { ok: false, reason: "unreachable" };

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    await response.body?.cancel().catch(() => null);
    return { ok: false, reason: "not_canvas" };
  }
  const text = await readCapped(response, MAX_RESPONSE_BYTES).catch(() => null);
  if (text === null) return { ok: false, reason: "not_canvas" };
  const user = canvasUserSchema.safeParse(parseJson(text));
  if (!user.success) return { ok: false, reason: "not_canvas" };

  return { ok: true, origin, user: readUser(user.data) };
}

/** The Canvas user in a `GET /users/self` answer, however it is wrapped. */
export function readCanvasUser(
  data: unknown,
): { id: string; name: string } | null {
  const direct = canvasUserSchema.safeParse(data);
  if (direct.success) return readUser(direct.data);
  const wrapped = z.object({ response_data: canvasUserSchema }).safeParse(data);
  return wrapped.success ? readUser(wrapped.data.response_data) : null;
}

export function canvasCheckMessage(reason: CanvasCheckFailure): string {
  return CHECK_MESSAGES[reason];
}

const CHECK_MESSAGES: Record<CanvasCheckFailure, string> = {
  rejected: "Canvas rejected this token. Check it or create a new one.",
  not_canvas: "That address doesn't look like a Canvas site.",
  unreachable: "Couldn't reach Canvas. Try again.",
  redirected:
    "That address sends you to another site. Enter the address Canvas opens at.",
};

const canvasUserSchema = z.object({
  id: z.union([z.number(), z.string().min(1)]),
  name: z.string().nullish(),
  short_name: z.string().nullish(),
});

function readUser(user: z.infer<typeof canvasUserSchema>) {
  return {
    id: String(user.id),
    name: user.name || user.short_name || "your Canvas account",
  };
}

/** The body as text, or null once it is over `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => null);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => null);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redirectTarget(response: Response, from: string) {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    return new URL(location, from).toString();
  } catch {
    return null;
  }
}

const canvasFetch: Fetch = (url, init) =>
  safeExternalFetch(url, {
    headers: init.headers,
    signal: init.signal ?? undefined,
  });
