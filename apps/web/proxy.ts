import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  appendVaryAccept,
  prefersMarkdown,
} from "@/utils/agent-markdown/accept";
import {
  getMarkdownForPath,
  markdownResponse,
} from "@/utils/agent-markdown/content";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/utils/branding";
import { MAIL_PATH_HEADER, MAIL_PATH_PREFIX } from "@/utils/mail-url";
import { buildLoginRedirectUrl } from "@/utils/redirect";

export function proxy(request: NextRequest) {
  if (isNextInternalRequest(request)) {
    return withVaryAccept(NextResponse.next());
  }

  // The app's layouts can't see the address they render under, so a signed-out
  // visit to a mail link is sent to log in from here, where the full address
  // is known and comes back after login. This only checks that a session
  // cookie exists; the layouts still verify the session itself.
  const { pathname, search } = request.nextUrl;
  if (isMailPath(pathname) && !getSessionCookie(request)) {
    return NextResponse.redirect(
      new URL(buildLoginRedirectUrl(`${pathname}${search}`), request.url),
    );
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withVaryAccept(NextResponse.next());
  }

  // The mail layout starts the inbox from the server only on the inbox, and
  // layouts are not told their address. Always set here, so it is never the
  // client's own value.
  if (isMailPath(pathname)) {
    const headers = new Headers(request.headers);
    headers.set(MAIL_PATH_HEADER, `${pathname}${search}`);
    return withVaryAccept(NextResponse.next({ request: { headers } }));
  }

  if (!prefersMarkdown(request.headers.get("accept"))) {
    return withVaryAccept(NextResponse.next());
  }

  const pageMarkdown = getMarkdownForPath(
    request.nextUrl.pathname,
    request.nextUrl.origin,
    { brandName: BRAND_NAME, supportEmail: SUPPORT_EMAIL },
  );
  if (pageMarkdown) {
    return markdownResponse(pageMarkdown);
  }

  return withVaryAccept(NextResponse.next());
}

export const config = {
  matcher: ["/", "/pricing", "/mail/u/:path*"],
};

function isMailPath(pathname: string) {
  return pathname.startsWith(`${MAIL_PATH_PREFIX}/`);
}

function isNextInternalRequest(request: NextRequest): boolean {
  return (
    request.headers.has("rsc") ||
    request.headers.has("next-router-state-tree") ||
    request.headers.has("next-router-prefetch") ||
    request.headers.has("next-router-segment-prefetch")
  );
}

function withVaryAccept(response: NextResponse): NextResponse {
  appendVaryAccept(response.headers);
  return response;
}
