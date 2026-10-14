/**
 * Where a label, folder or tab slug in the address stands: still waiting for
 * the names it resolves against, usable, or unusable because those names
 * failed to load, in which case the screen falls back to the inbox.
 */
export function getRouteResolution({
  resolved,
  loading,
  failed,
}: {
  resolved: boolean;
  loading: boolean;
  failed: boolean;
}): "resolving" | "ready" | "failed" {
  if (resolved) return "ready";
  if (failed) return "failed";
  if (loading) return "resolving";
  return "ready";
}
