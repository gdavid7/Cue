import { NextResponse } from "next/server";
import { Frequency } from "@/generated/prisma/enums";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { escapeHtml, trimToNonEmptyString } from "@/utils/string";
import { getUnsubscribeAction } from "@/utils/unsubscribe";
import { BRAND_NAME } from "@/utils/branding";

export const GET = withError("unsubscribe", async (request) => {
  const token = getTokenFromSearchParams(request);
  if (!token) {
    return createUnsubscribeResponse(request, {
      status: 400,
      title: "Invalid unsubscribe link",
      message: "This unsubscribe link is missing the required token.",
      json: { error: "Token is required" },
    });
  }

  const emailToken = await getValidEmailToken(token);
  if (!emailToken) {
    return createUnsubscribeResponse(request, {
      status: 400,
      title: "Link unavailable",
      message:
        "This unsubscribe link is invalid or has already been used. Request a new email to try again.",
      json: {
        error:
          "Invalid unsubscribe token. You might have already unsubscribed.",
      },
    });
  }

  return new Response(renderConfirmationPage(token), {
    headers: getHtmlHeaders(),
    status: 200,
  });
});

export const POST = withError("unsubscribe", async (request) => {
  const token = await getTokenFromRequest(request);
  if (!token) {
    return createUnsubscribeResponse(request, {
      status: 400,
      title: "Invalid unsubscribe request",
      message: "This unsubscribe request is missing the required token.",
      json: { error: "Token is required" },
    });
  }

  const emailToken = await getValidEmailToken(token);
  if (!emailToken) {
    return createUnsubscribeResponse(request, {
      status: 400,
      title: "Link unavailable",
      message:
        "This unsubscribe link is invalid or has already been used. Request a new email to try again.",
      json: {
        error:
          "Invalid unsubscribe token. You might have already unsubscribed.",
      },
    });
  }

  const [userUpdate, tokenDelete] = await Promise.allSettled([
    prisma.emailAccount.update({
      where: { id: emailToken.emailAccountId },
      data:
        getUnsubscribeAction(emailToken.token) === "meeting-recorder-recap"
          ? { meetingRecorderRecapEmailEnabled: false }
          : {
              summaryEmailFrequency: Frequency.NEVER,
              statsEmailFrequency: Frequency.NEVER,
            },
    }),
    prisma.emailToken.delete({ where: { id: emailToken.id } }),
  ]);

  if (userUpdate.status === "rejected") {
    request.logger.error("Error updating user preferences", {
      email: emailToken.emailAccount.email,
      error: userUpdate.reason,
    });

    return createUnsubscribeResponse(request, {
      status: 500,
      title: "Unsubscribe failed",
      message:
        "We couldn't update your email preferences right now. Visit Settings to unsubscribe manually.",
      json: {
        success: false,
        message:
          "Error unsubscribing. Visit Settings page to unsubscribe from emails.",
      },
    });
  }

  if (tokenDelete.status === "rejected") {
    request.logger.error("Error deleting token", {
      email: emailToken.emailAccountId,
      tokenId: emailToken.id,
      error: tokenDelete.reason,
    });
  }

  request.logger.info("User unsubscribed from emails", {
    email: emailToken.emailAccountId,
  });

  return createUnsubscribeResponse(request, {
    status: 200,
    title: "You're unsubscribed",
    message: "Email updates like this have been turned off for your account.",
    json: { success: true },
  });
});

async function getTokenFromRequest(request: Request) {
  const bodyToken = await getTokenFromFormBody(request);
  return bodyToken || getTokenFromSearchParams(request);
}

function getTokenFromSearchParams(request: Request) {
  const url = new URL(request.url);
  return trimToNonEmptyString(url.searchParams.get("token"));
}

async function getTokenFromFormBody(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded")) return;

  const formData = await request.formData();
  return trimToNonEmptyString(formData.get("token"));
}

async function getValidEmailToken(token: string) {
  const emailToken = await prisma.emailToken.findUnique({
    where: { token },
    include: { emailAccount: true },
  });

  if (!emailToken) return null;
  if (emailToken.expiresAt < new Date()) return null;

  return emailToken;
}

function createUnsubscribeResponse(
  request: Request,
  options: {
    status: number;
    title: string;
    message: string;
    json: Record<string, string | boolean>;
  },
) {
  if (wantsHtml(request)) {
    return new Response(renderStatusPage(options.title, options.message), {
      headers: getHtmlHeaders(),
      status: options.status,
    });
  }

  return NextResponse.json(options.json, { status: options.status });
}

function wantsHtml(request: Request) {
  const acceptHeader = request.headers.get("accept") || "";
  return request.method === "GET" || acceptHeader.includes("text/html");
}

function getHtmlHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

function renderConfirmationPage(token: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Confirm unsubscribe</title>
    <style>${PAGE_STYLES}</style>
  </head>
  <body>
    <main>
      <h1>Confirm unsubscribe</h1>
      <p>Click the button below to stop email updates like this from ${escapeHtml(BRAND_NAME)}.</p>
      <form method="POST" action="/api/unsubscribe">
        <input type="hidden" name="token" value="${escapeHtml(token)}" />
        <button type="submit">Unsubscribe</button>
      </form>
    </main>
  </body>
</html>`;
}

function renderStatusPage(title: string, message: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${escapeHtml(title)}</title>
    <style>${PAGE_STYLES}</style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

// The app's own light and dark tokens, chosen by the visitor's OS setting
// since this page renders outside the app and its theme preference.
const PAGE_STYLES = `
      :root {
        color-scheme: light dark;
        --background: #fdfdfd;
        --card: #ffffff;
        --border: #e6e6e6;
        --foreground: #242424;
        --muted: #737373;
        --primary: #2563eb;
        --primary-hover: #1d4ed8;
        --primary-foreground: #ffffff;
        --shadow: rgba(0, 0, 0, 0.06);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --background: #26282c;
          --card: #2d2f34;
          --border: #3a3d42;
          --foreground: #e9eaec;
          --muted: #a7a9af;
          --primary: #60a5fa;
          --primary-hover: #93c5fd;
          --primary-foreground: #1c1e21;
          --shadow: rgba(0, 0, 0, 0.3);
        }
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: var(--background);
        color: var(--foreground);
        font-family: ui-sans-serif, system-ui, sans-serif;
      }
      main {
        box-sizing: border-box;
        width: min(calc(100% - 2rem), 30rem);
        margin: 1rem;
        padding: 2rem;
        border-radius: 1rem;
        border: 1px solid var(--border);
        background: var(--card);
        box-shadow: 0 20px 50px var(--shadow);
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.75rem;
        letter-spacing: -0.02em;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.6;
      }
      p:not(:last-child) {
        margin-bottom: 1.5rem;
      }
      button {
        border: 0;
        border-radius: 999px;
        background: var(--primary);
        color: var(--primary-foreground);
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        padding: 0.875rem 1.25rem;
      }
      button:hover {
        background: var(--primary-hover);
      }
      button:active {
        transform: scale(0.97);
      }
      button:focus-visible {
        outline: 2px solid var(--primary);
        outline-offset: 2px;
      }
`;
