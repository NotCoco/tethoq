import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(here, "../..");
// Vite injects an inline React-refresh preamble in development. Give only
// this launch's generated scripts a nonce accepted by Electron's dev CSP.
const rendererNonce = randomBytes(18).toString("base64");
process.env.TETHOQ_DEV_CSP_NONCE = rendererNonce;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(here, "src/main/index.ts"),
          mesh_mcp_stdio: resolve(here, "../agent_bridge/src/mesh_mcp_stdio.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(here, "src/shared"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(here, "src/preload/index.ts"),
        // Electron's sandboxed preload loader executes CommonJS reliably in
        // packaged ASARs. An ESM preload can fail before contextBridge runs,
        // leaving the renderer with no trusted API and silently showing the
        // browser fixture instead.
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve(here, "src/shared"),
      },
    },
  },
  renderer: {
    html: { cspNonce: rendererNonce },
    root: resolve(here, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(here, "src/renderer"),
        "@shared": resolve(here, "src/shared"),
        "@repo": repositoryRoot,
      },
    },
    build: {
      rollupOptions: {
        input: resolve(here, "src/renderer/index.html"),
      },
    },
  },
});
