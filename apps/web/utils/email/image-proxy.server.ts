import "server-only";
import { DEFAULT_ASSET_PROXY_TTL_SECONDS } from "@inboxzero/image-proxy/proxy-url";
import { isTrackingImage } from "@inboxzero/mail-ui/tracking-images";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { isSentMessageOpenPixelUrl } from "@/utils/email/sent-message-open/sent-message-open";
import { getImageProxyBaseUrl } from "./image-proxy-config";
import { removeHtmlImages, rewriteHtmlRemoteAssetUrls } from "./rewrite-html";

let hasWarnedAboutUnsignedImageProxy = false;
let hasWarnedAboutDisabledAppRouteImageProxy = false;
let hasWarnedAboutDisabledProductionImageProxy = false;

export async function rewriteHtmlForImageProxy(html: string, logger: Logger) {
  const config = getImageProxyConfig(logger);
  if (!config || !html) {
    return { html, remoteAssetsProxied: false, proxyBaseUrl: null };
  }

  // The reader already removed these on its sanitized DOM. The composer sends
  // bare image sources, so this keeps the proxy from ever fetching the user's
  // own open pixel (which would count as an open) or a known tracker.
  const displayHtml = removeHtmlImages(
    html,
    (getAttribute) =>
      isSentMessageOpenPixelUrl(getAttribute("src")?.trim() ?? "") ||
      isTrackingImage(getAttribute),
  );

  return {
    html: await rewriteHtmlRemoteAssetUrls(displayHtml, {
      proxyBaseUrl: config.proxyBaseUrl,
      signingSecret: config.signingSecret,
      ttlSeconds: DEFAULT_ASSET_PROXY_TTL_SECONDS,
    }),
    remoteAssetsProxied: true,
    proxyBaseUrl: config.proxyBaseUrl,
  };
}

function getImageProxyConfig(logger: Logger) {
  const useAppRoute = env.NEXT_PUBLIC_IMAGE_PROXY_USE_APP_ROUTE;
  const proxyBaseUrl = getImageProxyBaseUrl({
    baseUrl: env.NEXT_PUBLIC_BASE_URL,
    externalProxyBaseUrl: env.NEXT_PUBLIC_IMAGE_PROXY_BASE_URL,
    useAppRoute,
  });
  const signingSecret = env.IMAGE_PROXY_SIGNING_SECRET?.split(
    ",",
    1,
  )[0]?.trim();

  if (!proxyBaseUrl) return null;

  if (!signingSecret) {
    if (useAppRoute) {
      if (!hasWarnedAboutDisabledAppRouteImageProxy) {
        hasWarnedAboutDisabledAppRouteImageProxy = true;
        logger.warn(
          "Email image proxy app route is disabled because IMAGE_PROXY_SIGNING_SECRET is missing.",
        );
      }

      return null;
    }

    if (env.NODE_ENV === "production") {
      if (!hasWarnedAboutDisabledProductionImageProxy) {
        hasWarnedAboutDisabledProductionImageProxy = true;
        logger.warn(
          "Email image proxy is disabled in production because IMAGE_PROXY_SIGNING_SECRET is missing.",
        );
      }

      return null;
    }

    if (!hasWarnedAboutUnsignedImageProxy) {
      hasWarnedAboutUnsignedImageProxy = true;
      logger.warn(
        "Email image proxy is enabled without IMAGE_PROXY_SIGNING_SECRET outside production. External assets will be routed through the configured proxy base URL using unsigned ?u= URLs.",
      );
    }
  }

  return { proxyBaseUrl, signingSecret: signingSecret || undefined };
}
