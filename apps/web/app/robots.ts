import type { MetadataRoute } from "next";
import { canonicalOrigin } from "@/lib/site-metadata";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/auth/", "/dashboard/"] },
    sitemap: `${canonicalOrigin}/sitemap.xml`,
    host: canonicalOrigin,
  };
}
