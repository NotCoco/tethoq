import type { MetadataRoute } from "next";
import { siteDescription } from "@/lib/site-metadata";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tethoq",
    short_name: "Tethoq",
    description: siteDescription,
    lang: "en-GB",
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: "#10100f",
    theme_color: "#10100f",
    icons: [{ src: "/tethoq-mark.png", sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
