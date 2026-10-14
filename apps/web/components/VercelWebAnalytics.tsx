import { Analytics } from "@vercel/analytics/react";
import { env } from "@/env";

// Vercel serves /_vercel/insights/script.js only for projects with Web
// Analytics enabled; elsewhere the script 404s on every page load.
export function VercelWebAnalytics() {
  if (!env.NEXT_PUBLIC_VERCEL_WEB_ANALYTICS_ENABLED) return null;
  return <Analytics />;
}
