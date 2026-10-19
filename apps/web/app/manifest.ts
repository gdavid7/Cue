import type { MetadataRoute } from "next";
import { BRAND_ICON_URL, BRAND_NAME } from "@/utils/branding";
import { THEME_COLOR_DARK } from "@/components/theme-options";
import { buildMailPath } from "@/utils/mail-url";

type ManifestIcon = NonNullable<MetadataRoute.Manifest["icons"]>[number];

const defaultIcons: ManifestIcon[] = [
  {
    src: "/icons/icon-192x192.png",
    sizes: "192x192",
    type: "image/png",
    purpose: "maskable",
  },
  {
    src: "/icons/icon-512x512.png",
    sizes: "512x512",
    type: "image/png",
  },
  {
    src: "/icons/icon-512x512.png",
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
];

export default function manifest(): MetadataRoute.Manifest {
  const customIcon: ManifestIcon[] =
    BRAND_ICON_URL === "/icon.png"
      ? []
      : [{ src: BRAND_ICON_URL, sizes: "any" as const }];

  return {
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    icons: [...customIcon, ...defaultIcons],
    theme_color: THEME_COLOR_DARK,
    background_color: THEME_COLOR_DARK,
    // `id` pins the app's identity to the old start_url, so changing where
    // it opens doesn't make browsers treat installs as a different app.
    id: "/",
    start_url: buildMailPath({ accountIndex: 0 }),
    display: "standalone",
    orientation: "portrait",
  };
}
