import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

async function exists(path) {
  try {
    await access(join(root, path));
    return true;
  } catch {
    return false;
  }
}

test("project is a standard Next.js app without abandoned hosting layers", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts.build, /^next build$/u);
  assert.ok(packageJson.dependencies.next);
  for (const dependency of ["vinext", "vite", "wrangler", "@cloudflare/vite-plugin"]) {
    assert.equal(packageJson.dependencies?.[dependency] ?? packageJson.devDependencies?.[dependency], undefined);
  }
  for (const path of [".openai", "worker", "vite.config.ts", "drizzle.config.ts"]) {
    assert.equal(await exists(path), false, `${path} should not remain`);
  }
});

test("public pages distinguish desktop and bridge releases without placeholder links", async () => {
  const download = await readFile(join(root, "app", "download", "page.tsx"), "utf8");
  const auth = await readFile(join(root, "components", "auth-form.tsx"), "utf8");
  const env = await readFile(join(root, ".env.example"), "utf8");
  assert.match(download, /Tethoq Desktop/u);
  assert.match(download, /Tethoq Bridge/u);
  assert.match(download, /Provider-neutral SDK for user-installed community connectors/u);
  assert.match(download, /Community connectors require local review and explicit approval/u);
  assert.match(download, /No placeholder download/u);
  assert.match(auth, /Account services are not configured/u);
  assert.match(env, /NEXT_PUBLIC_DESKTOP_WINDOWS_DOWNLOAD_URL=/u);
  assert.match(env, /NEXT_PUBLIC_BRIDGE_WINDOWS_DOWNLOAD_URL=/u);
  assert.match(env, /NEXT_PUBLIC_DESKTOP_CHECKSUM_URL=/u);
  assert.match(env, /NEXT_PUBLIC_BRIDGE_CHECKSUM_URL=/u);
  assert.doesNotMatch(env, /service_role/u);
});

test("public website advertises the complete built-in provider set", async () => {
  async function publicSource(directory) {
    const sources = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) sources.push(await publicSource(path));
      else if (/\.(?:css|js|json|ts|tsx)$/u.test(entry.name)) sources.push(await readFile(path, "utf8"));
    }
    return sources.join("\n");
  }

  const source = (await Promise.all(
    ["app", "components", "lib", "public"].map((directory) => publicSource(join(root, directory))),
  )).join("\n");
  const builtIns = ["Codex", "OpenCode", "Grok Build", "Pi", "OMP", "Qwen Code", "goose", "Kimi Code", "Hermes Agent", "Cline", "Copilot CLI", "Direct API"];

  for (const provider of builtIns) assert.match(source, new RegExp(provider, "u"));
  assert.doesNotMatch(source, /Claude(?: Code)?|Anthropic|providers\/claude/iu);

  const layout = await readFile(join(root, "app", "layout.tsx"), "utf8");
  assert.match(layout, /keywords:[\s\S]*"Codex"[\s\S]*"OpenCode"[\s\S]*"Grok"/u);
  const homepage = await readFile(join(root, "app", "page.tsx"), "utf8");
  for (const harness of ["Codex", "Grok Build", "OpenCode"]) assert.match(homepage, new RegExp(`${harness} connected`, "u"));
  assert.match(homepage, /12 built-in routes/u);
  assert.match(homepage, /provider-neutral connector SDK/u);
  assert.match(homepage, /Community connectors are independent user-installed software/u);
});

test("OAuth callback permits only local paths", async () => {
  const callback = await readFile(join(root, "app", "auth", "callback", "route.ts"), "utf8");
  assert.match(callback, /startsWith\("\/"\)/u);
  assert.match(callback, /!requestedNext\.startsWith\("\/\/"\)/u);
  assert.match(callback, /!requestedNext\.includes\("\\\\"\)/u);
  assert.match(callback, /exchangeCodeForSession/u);
});

test("source text contains valid UTF-8 rather than mojibake", async () => {
  async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await walk(path));
      else files.push(path);
    }
    return files;
  }

  for (const path of await walk(root)) {
    if (!/\.(?:css|example|js|json|md|mjs|sql|ts|tsx)$/u.test(path)) continue;
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /[\u00c2\u00c3\u00e2\u00f0\ufffd]/u, `mojibake marker in ${path}`);
  }
});
