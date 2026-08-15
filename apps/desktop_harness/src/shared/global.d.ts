import type { DesktopHarnessApi } from "./desktop_api.js";

declare global {
  interface Window {
    readonly tethoqDesktop: DesktopHarnessApi;
  }
}

export {};
