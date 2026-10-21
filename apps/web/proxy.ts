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
import { getLegacyHostRedirect } from "@/utils/legacy-host";
import { buildLoginRedirectUrl } from "@/utils/redirect";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const legacyRedirect = getLegacyHostRedirect({
    host: request.headers.get("host"),
    pathname,
    search,
    baseUrl: process.env.NEXT_PUBLIC_BASE_URL,
  });
  if (legacyRedirect) {
    return NextResponse.redirect(legacyRedirect, 308);
  }

  // The matcher is broad so old-host pages can be redirected; everything else
  // keeps its previous, proxy-free behavior.
  if (!isProxiedPath(pathname)) return NextResponse.next();

  // Only the proxy says which mail address a layout renders under, so a value
  // the client sent never reaches the app.
  const headers = new Headers(request.headers);
  const sentMailPath = headers.has(MAIL_PATH_HEADER);
  headers.delete(MAIL_PATH_HEADER);
  const next = () =>
    sentMailPath
      ? NextResponse.next({ request: { headers } })
      : NextResponse.next();

  if (isNextInternalRequest(request)) {
    return withVaryAccept(next());
  }

  // The app's layouts can't see the address they render under, so a signed-out
  // visit to a mail link is sent to log in from here, where the full address
  // is known and comes back after login. This only checks that a session
  // cookie exists; the layouts still verify the session itself.
  if (isMailPath(pathname) && !getSessionCookie(request)) {
    return NextResponse.redirect(
      new URL(buildLoginRedirectUrl(`${pathname}${search}`), request.url),
    );
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withVaryAccept(next());
  }

  // The mail layout starts the inbox from the server when the document is
  // the inbox, and layouts are not told their address.
  if (request.method === "GET" && isMailPath(pathname)) {
    headers.set(MAIL_PATH_HEADER, `${pathname}${search}`);
    return withVaryAccept(NextResponse.next({ request: { headers } }));
  }

  const pageMarkdown = prefersMarkdown(request.headers.get("accept"))
    ? getMarkdownForPath(pathname, request.nextUrl.origin, {
        brandName: BRAND_NAME,
        supportEmail: SUPPORT_EMAIL,
      })
    : null;
  if (pageMarkdown) {
    return markdownResponse(pageMarkdown);
  }

  // The root page only sends a signed-out visitor to log in, so answering
  // here spares them a cold start of the page and its auth stack. Requests
  // with a session cookie still reach the page, which verifies it.
  if (pathname === "/" && !getSessionCookie(request)) {
    return withVaryAccept(
      NextResponse.redirect(new URL("/login", request.url)),
    );
  }

  return withVaryAccept(next());
}

export const config = {
  matcher: ["/((?!api/|_next/|monitoring|\\.well-known/|sw\\.js|.*\\..*).*)"],
};

function isProxiedPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/pricing" ||
    pathname === "/pricing/" ||
    isMailPath(pathname)
  );
}

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
