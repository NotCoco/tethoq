import type { Metadata, Viewport } from "next";
import { canonicalOrigin, openGraph, siteDescription, siteTitle, twitter } from "@/lib/site-metadata";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(canonicalOrigin),
  title: { default: siteTitle, template: "%s — Tethoq" },
  description: siteDescription,
  applicationName: "Tethoq",
  keywords: ["Tethoq", "Codex", "OpenCode", "Grok", "coding harnesses", "remote coding agents"],
  alternates: { canonical: "/" },
  manifest: "/manifest.webmanifest",
  robots: { index: true, follow: true, googleBot: { "max-image-preview": "large" } },
  icons: {
    icon: [{ url: "/tethoq-mark.png", type: "image/png", sizes: "512x512" }],
    apple: [{ url: "/tethoq-mark.png", type: "image/png", sizes: "512x512" }],
  },
  openGraph: { ...openGraph, url: canonicalOrigin },
  twitter,
};

export const viewport: Viewport = { themeColor: "#10100f", colorScheme: "dark" };

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "@id": `${canonicalOrigin}/#website`, name: "Tethoq", url: canonicalOrigin, inLanguage: "en-GB" },
    {
      "@type": "SoftwareApplication",
      "@id": `${canonicalOrigin}/#application`,
      name: "Tethoq",
      url: canonicalOrigin,
      description: siteDescription,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Windows 10, Windows 11",
      image: `${canonicalOrigin}/tethoq-mark.png`,
      isAccessibleForFree: true,
      sameAs: "https://github.com/NotCoco/tethoq",
    },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
        {children}
      </body>
    </html>
  );
}
