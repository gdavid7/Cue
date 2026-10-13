import Image from "next/image";
import { DomainIcon } from "@/components/charts/DomainIcon";

/**
 * An app's own logo when we ship one; otherwise its site's favicon, which for
 * apps like Drive or Teams would be the parent company's mark instead.
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
  if (!logo) return <DomainIcon domain={domain} size={size} />;
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
