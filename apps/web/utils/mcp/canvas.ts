import { z } from "zod";
import { isSafeExternalHttpUrl } from "@inboxzero/network/safe-url";
import { safeExternalFetch } from "@/utils/mcp/safe-fetch";

// Long enough for a slow school server, short enough to answer a form.
const VERIFY_TIMEOUT_MS = 8000;
const MAX_SAME_SITE_REDIRECTS = 3;

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
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
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
 * hosts are called, and the token never follows a redirect to another site.
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
  try {
    for (let hop = 0; hop <= MAX_SAME_SITE_REDIRECTS; hop++) {
      response = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (response.status < 300 || response.status >= 400) break;
      const next = redirectTarget(response, url);
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
  if (!contentType.includes("json")) return { ok: false, reason: "not_canvas" };
  const user = canvasUserSchema.safeParse(
    await response.json().catch(() => null),
  );
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
