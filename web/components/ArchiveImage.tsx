"use client";

import Image from "next/image";
import { useState } from "react";

/** Preserve the original figure link even if the image optimizer is unavailable. */
export default function ArchiveImage({ src, alt, width, height, eager = false }: {
  src: string; alt: string; width: number; height: number; eager?: boolean;
}) {
  const [fallback, setFallback] = useState(false);
  const props = { src, alt, width, height, loading: eager ? "eager" as const : "lazy" as const,
    decoding: "async" as const, fetchPriority: eager ? "high" as const : "auto" as const };
  // The surrounding figure always links to the untouched source file.
  return fallback
    ? <img {...props} />
    : <Image {...props} sizes="(max-width: 780px) calc(100vw - 48px), 740px"
        onError={() => setFallback(true)} />;
}
