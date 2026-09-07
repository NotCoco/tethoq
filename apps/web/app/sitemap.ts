import type { MetadataRoute } from "next";
import { canonicalOrigin } from "@/lib/site-metadata";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: canonicalOrigin, lastModified: "2026-09-07" },
    { url: `${canonicalOrigin}/download`, lastModified: "2026-09-07" },
  ];
}
