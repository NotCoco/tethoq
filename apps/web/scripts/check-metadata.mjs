import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const liveOrigin = process.argv[2];
const canonical = "https://tethoq.com";
const imagePath = "/tethoq-x-banner-v2.png";

async function load(path, localPath, userAgent = "LinkedInBot/1.0") {
  if (!liveOrigin) return readFile(localPath);
  const response = await fetch(new URL(path, liveOrigin), {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `${path} must be publicly available`);
  return Buffer.from(await response.arrayBuffer());
}

function attributes(html, tag, key, value) {
  for (const match of html.matchAll(new RegExp(`<${tag}\\s([^>]+)>`, "g"))) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((item) => [item[1], item[2]]));
    if (attrs[key] === value) return attrs;
  }
  assert.fail(`Missing ${tag} ${key}=${value}`);
}

for (const [path, filename, title] of [
  ["/", "index", "Tethoq — Your coding agents, within reach"],
  ["/download", "download", "Download for Windows — Tethoq"],
]) {
  for (const userAgent of liveOrigin ? ["LinkedInBot/1.0", "Twitterbot/1.0"] : ["build"]) {
    const html = (await load(path, `.next/server/app/${filename}.html`, userAgent)).toString();
    const head = html.split("</head>")[0];
    assert.ok(head.includes(`<title>${title}</title>`), `${path}: descriptive title in the head`);
    const description = attributes(head, "meta", "name", "description").content;
    assert.ok(description.length > 50);
    const canonicalHref = attributes(head, "link", "rel", "canonical").href;
    assert.equal(new URL(canonicalHref).href, new URL(path, canonical).href);
    assert.equal(new URL(attributes(head, "meta", "property", "og:url").content).href, new URL(path, canonical).href);
    assert.equal(attributes(head, "meta", "property", "og:site_name").content, "Tethoq");
    assert.equal(attributes(head, "meta", "property", "og:image").content, canonical + imagePath);
    assert.equal(attributes(head, "meta", "property", "og:image:width").content, "1500");
    assert.equal(attributes(head, "meta", "property", "og:image:height").content, "500");
    assert.ok(attributes(head, "meta", "property", "og:image:alt").content.includes("Tethoq"));
    assert.equal(attributes(head, "meta", "property", "og:description").content, description);
    assert.equal(attributes(head, "meta", "name", "twitter:description").content, description);
    assert.equal(attributes(head, "meta", "name", "twitter:card").content, "summary_large_image");
    assert.equal(attributes(head, "meta", "name", "twitter:image").content, canonical + imagePath);
    assert.ok(attributes(head, "meta", "name", "twitter:image:alt").content.includes("Tethoq"));
    assert.match(head, /rel="icon"[^>]*href="\/favicon\.ico/);
    assert.equal(attributes(head, "link", "rel", "apple-touch-icon").href, "/tethoq-mark.png");
    assert.equal(attributes(head, "link", "rel", "manifest").href, "/manifest.webmanifest");
    assert.doesNotMatch(attributes(head, "meta", "name", "robots").content, /noindex/);
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/)[1]);
    assert.ok(data["@graph"].some((item) => item["@type"] === "WebSite" && item.url === canonical));
    assert.ok(data["@graph"].some((item) => item["@type"] === "SoftwareApplication" && item.name === "Tethoq"));
    console.log(`PASS ${path} metadata (${userAgent})`);
  }
}

const icon = await load("/favicon.ico", ".next/server/app/favicon.ico.body");
assert.equal(icon.readUInt16LE(2), 1);
const sizes = Array.from({ length: icon.readUInt16LE(4) }, (_, index) => icon[6 + index * 16] || 256);
for (const size of [16, 32, 48, 256]) assert.ok(sizes.includes(size), `favicon needs a ${size}px image`);
for (const [path, width, height] of [[imagePath, 1500, 500], ["/tethoq-mark.png", 512, 512]]) {
  const png = await load(path, `public${path}`);
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
  assert.ok(png.length < 5_000_000);
}
const manifest = JSON.parse((await load("/manifest.webmanifest", ".next/server/app/manifest.webmanifest.body")).toString());
assert.equal(manifest.name, "Tethoq");
assert.equal(manifest.icons[0].src, "/tethoq-mark.png");
const robots = (await load("/robots.txt", ".next/server/app/robots.txt.body")).toString();
assert.ok(robots.includes(`Sitemap: ${canonical}/sitemap.xml`));
assert.ok(robots.includes("Allow: /"));
const sitemap = (await load("/sitemap.xml", ".next/server/app/sitemap.xml.body")).toString();
assert.equal([...sitemap.matchAll(/<loc>/g)].length, 2);
assert.ok(sitemap.includes(`<loc>${canonical}/download</loc>`));
assert.doesNotMatch(sitemap, /localhost|vercel\.app|\/auth\/|\/dashboard/);
console.log("PASS public favicon, sharing image, bookmark logo, manifest, robots and sitemap");
