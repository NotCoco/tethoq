import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteDescription = "A free, open-source Windows workspace for your coding agents. Download Tethoq Desktop with Bridge included, or install Bridge on its own.";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: "Tethoq — Your coding agents, within reach", template: "%s — Tethoq" },
  description: siteDescription,
  applicationName: "Tethoq",
  keywords: ["Tethoq", "Codex", "OpenCode", "Grok", "coding harnesses", "remote coding agents"],
  icons: {
    icon: [{ url: "/tethoq-mark.png", type: "image/png", sizes: "512x512" }],
    apple: [{ url: "/tethoq-mark.png", type: "image/png", sizes: "512x512" }],
  },
  openGraph: { title: "Tethoq", description: siteDescription, type: "website" },
  twitter: { card: "summary", title: "Tethoq", description: siteDescription },
};

export const viewport: Viewport = { themeColor: "#10100f", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
