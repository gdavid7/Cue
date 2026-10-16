import type { LookupAddress } from "node:dns";
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { env } from "@/env";
import type { ResolvedMcpIntegration } from "@/utils/mcp/resolve-integration";
import {
  isSafeExternalHttpUrl,
  resolveSafeExternalHttpUrl,
} from "@inboxzero/network/safe-url";

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Built-in integrations point at endpoints we control, so they use the default
 * fetch. User-registered servers go through the guarded one.
 */
export function getMcpFetch(
  integration: ResolvedMcpIntegration,
): FetchLike | undefined {
  return integration.isCustom ? safeMcpFetch : undefined;
}

/**
 * The URL policy for user-registered MCP servers, checked both when a server is
 * added and on every request to it. Returns why the URL is refused, if it is.
 */
export function getCustomMcpServerUrlError(url: string): string | null {
  const allowPrivateIps = env.MCP_ALLOW_PRIVATE_IPS;

  if (!allowPrivateIps && !url.startsWith("https://")) {
    return "The server URL must use https";
  }

  if (!isSafeExternalHttpUrl(url, { allowPrivateIps })) {
    return "That server URL is not a public address";
  }

  return null;
}

/**
 * Fetch for user-registered MCP servers. Every URL here is user controlled, so
 * besides the checks in `safeExternalFetch`, redirects are refused because
 * they would skip the URL policy.
 */
const safeMcpFetch: FetchLike = async (url, init) => {
  const target = url.toString();

  const urlError = getCustomMcpServerUrlError(target);
  if (urlError) {
    throw new Error(`Refusing to call ${safeHost(target)}: ${urlError}`);
  }

  const response = await safeExternalFetch(target, init as UndiciRequestInit, {
    allowPrivateIps: env.MCP_ALLOW_PRIVATE_IPS,
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Refusing to follow a redirect from ${safeHost(target)}: custom MCP servers may not redirect`,
    );
  }

  return response;
};

const safeAgent = new Agent({
  connect: { lookup: safeLookup(false) },
});
const privateIpsAgent = new Agent({
  connect: { lookup: safeLookup(true) },
});

/**
 * Fetch for a URL the user gave us. The target is re-checked (undici skips the
 * lookup hook for IP literals), hostname connections are pinned to addresses
 * that passed the SSRF guard, and a redirect comes back as the 3xx response
 * instead of being followed, so the caller decides whether its target is safe.
 *
 * Uses undici's own fetch because the pinned-DNS dispatcher comes from the
 * undici package, which Node's global fetch rejects across versions.
 */
export async function safeExternalFetch(
  url: string,
  init: UndiciRequestInit = {},
  { allowPrivateIps = false }: { allowPrivateIps?: boolean } = {},
): Promise<Response> {
  if (!isSafeExternalHttpUrl(url, { allowPrivateIps })) {
    throw new Error(`Refusing to call ${safeHost(url)}: not a public address`);
  }

  const response = await undiciFetch(url, {
    ...init,
    redirect: "manual",
    dispatcher: allowPrivateIps ? privateIpsAgent : safeAgent,
  });
  return response as unknown as Response;
}

function safeLookup(allowPrivateIps: boolean) {
  return (hostname: string, options: unknown, callback: LookupCallback) => {
    const host = hostname.includes(":") ? `[${hostname}]` : hostname;

    resolveSafeExternalHttpUrl(`https://${host}`, { allowPrivateIps })
      .then((resolved) => {
        if (!resolved) {
          callback(
            Object.assign(
              new Error(`Refusing to call ${hostname}: not a public host`),
              { code: "ENOTFOUND" },
            ),
            "",
          );
          return;
        }

        resolved.lookup(hostname, options as never, callback);
      })
      .catch((error) => callback(error as NodeJS.ErrnoException, ""));
  };
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}
