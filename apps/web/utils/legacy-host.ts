const LEGACY_HOSTS = ["cue-inbox.vercel.app", "cue-ten-blue.vercel.app"];

// Webhooks, push notifications and crons are still registered against the old
// hosts, so only page requests move; API, Next internals, the service worker,
// well-known files and static files (anything with an extension, except mail
// addresses, whose ids can contain dots) keep being served in place.
export const LEGACY_PAGE_SOURCE =
  "/:path((?!api/|_next/|monitoring(?:/|$)|\\.well-known/|sw\\.js$)(?!(?!mail/).*\\.[A-Za-z0-9]+$).*)";

export function getLegacyHostRedirects(baseUrl: string | undefined) {
  const target = parseOrigin(baseUrl);
  if (!target || LEGACY_HOSTS.includes(target.host.toLowerCase())) return [];

  return [
    {
      source: LEGACY_PAGE_SOURCE,
      has: [
        {
          type: "host" as const,
          value: LEGACY_HOSTS.map((host) => host.replaceAll(".", "\\.")).join(
            "|",
          ),
        },
      ],
      destination: `${target.origin}/:path`,
      permanent: true,
    },
  ];
}

function parseOrigin(baseUrl: string | undefined) {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
}
