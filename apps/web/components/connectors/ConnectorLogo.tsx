import Image from "next/image";
import { SiteIcon } from "@/components/SiteIcon";

/**
 * An app's own logo when we ship one; otherwise its site's favicon, which for
 * apps like Drive or Teams would be the parent company's mark instead.
 * `domain` is used as given (connector domains name the app's own site), so the
 * landing page doesn't download the public suffix list; for an arbitrary host,
 * such as a custom server's, use DomainIcon.
 */
export function ConnectorLogo({
  logo,
  domain,
  size,
}: {
  logo?: string;
  domain: string;
  size: number;
}) {
  if (!logo) return <SiteIcon domain={domain} size={size} />;
  return (
    <Image
      alt=""
      className="shrink-0"
      height={size}
      src={logo}
      unoptimized
      width={size}
    />
  );
}
