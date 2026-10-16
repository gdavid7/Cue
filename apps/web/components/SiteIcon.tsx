"use client";

import Image from "next/image";
import { useState } from "react";
import { cn } from "@/utils";

/**
 * A site's favicon for a domain used exactly as given, falling back to a
 * colored tile. Kept free of the public suffix list (tldts, about 45 KB gzip):
 * callers that only have a subdomain resolve it with DomainIcon instead.
 */
export function SiteIcon({
  domain,
  size = 20,
  variant = "default",
  fallbackSeed = domain,
}: {
  domain: string;
  size?: number;
  variant?: "default" | "circular";
  /** What picks the fallback tile's color; defaults to `domain`. */
  fallbackSeed?: string;
}) {
  const [fallbackEnabled, setFallbackEnabled] = useState(false);

  return (
    <div
      style={{ width: size, height: size }}
      className={cn(
        "relative shrink-0 overflow-hidden",
        variant === "circular" ? "rounded-full" : "rounded",
      )}
    >
      {fallbackEnabled || !domain ? (
        <FallbackIcon seed={fallbackSeed} size={size} />
      ) : (
        <Image
          width={size}
          height={size}
          src={getFavicon(domain)}
          alt=""
          className="z-10 rounded"
          onError={() => setFallbackEnabled(true)}
        />
      )}
    </div>
  );
}

export function FallbackIcon({
  seed,
  size = 20,
}: {
  seed: string;
  size?: number;
}) {
  const hash = seed
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);

  const gradients = [
    "from-blue-300 to-blue-700",
    "from-purple-300 to-purple-700",
    "from-green-300 to-green-700",
    "from-emerald-300 to-emerald-700",
    "from-yellow-300 to-yellow-700",
    "from-orange-300 to-orange-700",
    "from-red-300 to-red-700",
    "from-indigo-300 to-indigo-700",
    "from-pink-300 to-pink-700",
    "from-fuchsia-300 to-fuchsia-700",
    "from-rose-300 to-rose-700",
    "from-sky-300 to-sky-700",
    "from-teal-300 to-teal-700",
    "from-violet-300 to-violet-700",
  ];

  const gradientIndex = hash % gradients.length;

  return (
    <div
      style={{ width: size, height: size }}
      className={cn("z-10 rounded bg-gradient-to-r", gradients[gradientIndex])}
    />
  );
}

function getFavicon(domain: string) {
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://${domain}&size=64`;
}
