/**
 * Names the deployment that answered a mail engine request, so a page left
 * open across a deploy can tell its code is no longer the server's.
 */
export const SERVER_BUILD_HEADER = "x-cue-build";

/**
 * Reads the deployment id Next.js uses for its own skew protection (Vercel
 * sets NEXT_DEPLOYMENT_ID per deployment) at build time, so each deployment
 * names itself in its own routes and an instant rollback answers with the old
 * name. Without one, as in local and CI builds, there is no route (Next.js
 * rejects an empty header list) and pages never reload for a new build.
 */
export function serverBuildHeaderRoutes(deploymentId: string | undefined) {
  if (!deploymentId) return [];
  return [
    {
      source: "/api/mail/v1/:path*",
      headers: [{ key: SERVER_BUILD_HEADER, value: deploymentId }],
    },
  ];
}
