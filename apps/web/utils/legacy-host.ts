const LEGACY_HOSTS = new Set([
  "cue-inbox.vercel.app",
  "cue-ten-blue.vercel.app",
]);

// Webhooks, push notifications and crons are still registered against the old
// hosts, so only page requests move; the rest keep being served in place.
const UNREDIRECTED_PREFIXES = [
  "/api/",
  "/_next/",
  "/monitoring",
  "/.well-known/",
];

export function getLegacyHostRedirect({
  host,
  pathname,
  search,
  baseUrl,
}: {
  host: string | null;
  pathname: string;
  search: string;
  baseUrl: string | undefined;
}): string | null {
  if (!host || !baseUrl || !LEGACY_HOSTS.has(host.toLowerCase())) return null;
  if (isUnredirectedPath(pathname)) return null;

  let target: URL;
  try {
    target = new URL(baseUrl);
  } catch {
    return null;
  }
  if (target.host.toLowerCase() === host.toLowerCase()) return null;

  return `${target.origin}${pathname}${search}`;
}

function isUnredirectedPath(pathname: string) {
  if (pathname === "/sw.js") return true;
  if (UNREDIRECTED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return true;
  }
  // Static assets, manifests and other files.
  return /\.[a-z0-9]+$/i.test(pathname.split("/").pop() ?? "");
}
