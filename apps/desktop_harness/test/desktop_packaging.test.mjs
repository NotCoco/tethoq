import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const source = async (path) => readFile(new URL(path, import.meta.url));

function iconDirectory(buffer) {
  assert.equal(buffer.readUInt16LE(0), 0);
  assert.equal(buffer.readUInt16LE(2), 1);
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_, index) => {
    const offset = 6 + index * 16;
    return {
      width: buffer[offset] || 256,
      height: buffer[offset + 1] || 256,
      planes: buffer.readUInt16LE(offset + 4),
      bits: buffer.readUInt16LE(offset + 6),
      bytes: buffer.readUInt32LE(offset + 8),
      offset: buffer.readUInt32LE(offset + 12),
    };
  });
}

test("Windows brand assets cover shell, installer, and high-DPI icon sizes", async () => {
  const [icon, runtimePng] = await Promise.all([
    source("../build/icons/tethoq.ico"),
    source("../build/icons/tethoq.png"),
  ]);
  const entries = iconDirectory(icon);
  assert.deepEqual(entries.map((entry) => entry.width), [16, 20, 24, 32, 40, 48, 64, 128, 256]);
  assert.ok(entries.every((entry) => entry.width === entry.height && entry.planes === 1 && entry.bits === 32));
  assert.ok(entries.every((entry) => entry.offset + entry.bytes <= icon.length));
  assert.deepEqual([...runtimePng.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(runtimePng.readUInt32BE(16), 512);
  assert.equal(runtimePng.readUInt32BE(20), 512);
  assert.equal(runtimePng[25], 6, "runtime PNG must carry an alpha channel");

  for (const name of ["installer-header.bmp", "installer-sidebar.bmp", "uninstaller-sidebar.bmp"]) {
    const bitmap = await source(`../build/installer/${name}`);
    assert.equal(bitmap.subarray(0, 2).toString("ascii"), "BM");
    const expected = name === "installer-header.bmp" ? [150, 57] : [164, 314];
    assert.deepEqual([bitmap.readInt32LE(18), bitmap.readInt32LE(22)], expected);
  }
});

test("Windows packaging applies Tethoq identity to executable, installer, shortcuts, and uninstall metadata", async () => {
  const [config, viteConfig, packageJson, assetScript, assetsReadme] = await Promise.all([
    source("../electron-builder.yml").then(String),
    source("../electron.vite.config.ts").then(String),
    source("../package.json").then(String),
    source("../scripts/build-brand-assets.ps1").then(String),
    source("../assets/README.md").then(String),
  ]);

  assert.match(packageJson, /"productName":\s*"Tethoq"/);
  assert.match(packageJson, /"author":\s*\{[\s\S]*?"name":\s*"Tethoq"/);
  assert.match(packageJson, /build:brand-assets/);
  assert.match(packageJson, /"pack:win":\s*"npm run build:brand-assets/);
  assert.match(config, /appId:\s*app\.tethoq\.desktop/);
  assert.match(config, /from:\s*\.\.\/\.\.\/LICENSE[\s\S]*?to:\s*legal\/TETHOQ-LICENSE\.txt/);
  assert.match(config, /from:\s*\.\.\/\.\.\/THIRD_PARTY_NOTICES\.md[\s\S]*?to:\s*legal\/THIRD_PARTY_NOTICES\.md/);
  assert.match(config, /from:\s*\.\.\/\.\.\/third_party[\s\S]*?to:\s*legal\/third_party/);
  assert.match(config, /executableName:\s*Tethoq/);
  assert.match(config, /win:[\s\S]*?icon:\s*build\/icons\/tethoq\.ico/);
  assert.match(config, /from:\s*build\/icons\/tethoq\.png[\s\S]*?to:\s*assets\/tethoq-icon\.png/);
  assert.match(config, /from:\s*\.\.\/agent_bridge\/assets\/opencode\/uar_mesh\.txt[\s\S]*?to:\s*provider-tools\/opencode\/uar_mesh\.txt/);
  assert.match(config, /from:\s*\.\.\/agent_bridge\/assets\/pi\/tethoq_tools\.txt[\s\S]*?to:\s*provider-tools\/pi\/tethoq_tools\.txt/);
  assert.match(viteConfig, /mesh_mcp_stdio:\s*resolve\(here, "\.\.\/agent_bridge\/src\/mesh_mcp_stdio\.ts"\)/);
  assert.match(config, /installerIcon:\s*build\/icons\/tethoq\.ico/);
  assert.match(config, /uninstallerIcon:\s*build\/icons\/tethoq\.ico/);
  assert.match(config, /installerHeader:\s*build\/installer\/installer-header\.bmp/);
  assert.match(config, /installerSidebar:\s*build\/installer\/installer-sidebar\.bmp/);
  assert.match(config, /uninstallerSidebar:\s*build\/installer\/uninstaller-sidebar\.bmp/);
  assert.match(config, /shortcutName:\s*Tethoq/);
  assert.match(config, /uninstallDisplayName:\s*Tethoq Desktop \$\{version\}/);
  assert.match(config, /perMachine:\s*false/);
  assert.match(config, /requestedExecutionLevel:\s*asInvoker/);
  assert.match(config, /deleteAppDataOnUninstall:\s*false/);
  assert.match(assetScript, /512x512/);
  assert.match(assetsReadme, /deterministic output/);
  assert.doesNotMatch(`${config}\n${packageJson}\n${assetScript}`, /Claude/i);
});

test("packaged Windows executable resources carry only Tethoq product metadata", async (context) => {
  if (process.platform !== "win32") return;
  const executable = new URL("../release-brand-qa/win-unpacked/Tethoq.exe", import.meta.url);
  try { await access(executable); } catch { context.skip("Run the isolated Windows directory packaging check first"); return; }
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const script = `$value=(Get-Item -LiteralPath '${decodeURIComponent(executable.pathname.slice(1)).replaceAll("'", "''")}').VersionInfo; $value | Select-Object CompanyName,FileDescription,ProductName,LegalCopyright,OriginalFilename | ConvertTo-Json -Compress`;
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  const metadata = JSON.parse(stdout);
  assert.deepEqual(metadata, {
    CompanyName: "Tethoq",
    FileDescription: "Tethoq",
    ProductName: "Tethoq",
    LegalCopyright: "Copyright (c) 2026 Tethoq",
    OriginalFilename: "",
  });
});
