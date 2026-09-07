export const canonicalOrigin = "https://tethoq.com";
export const siteTitle = "Tethoq — Your coding agents, within reach";
export const siteDescription = "A free, open-source Windows workspace for your coding agents. Download Tethoq Desktop with Bridge included, or install Bridge on its own.";

export const socialImage = {
  url: `${canonicalOrigin}/tethoq-x-banner-v2.png`,
  width: 1500,
  height: 500,
  alt: "Tethoq — Your coding agents, within reach. The Tethoq logo connects a computer, phone and code editor.",
};

export const openGraph = {
  title: siteTitle,
  description: siteDescription,
  siteName: "Tethoq",
  locale: "en_GB",
  type: "website" as const,
  images: [socialImage],
};

export const twitter = {
  card: "summary_large_image" as const,
  title: siteTitle,
  description: siteDescription,
  images: [{ url: socialImage.url, alt: socialImage.alt }],
};
