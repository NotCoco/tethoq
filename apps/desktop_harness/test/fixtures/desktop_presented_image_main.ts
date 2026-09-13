import { app, BrowserWindow, ipcMain } from "electron";
import { copyFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHostIdentity, CURRENT_PROTOCOL_VERSION } from "../../../../packages/protocol/src/index";
import { FakeProviderAdapter } from "../../../../packages/provider_fake/src/index";
import { AgentBridge } from "../../../agent_bridge/src/bridge";
import { BridgeRequestRouter } from "../../../agent_bridge/src/request_router";

app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", join(__dirname, "profile"));
const hostId = "image-mounted";
class Provider extends FakeProviderAdapter {
  constructor() { super({ hostId, providerId: "opencode", sessionCount: 1 }); }
  override async getMessages() { return []; }
}
const config = { version: 1 as const, hostId, displayName: "Image QA", enabledProviders: ["opencode"], identity: createHostIdentity() };
const makeBridge = () => new AgentBridge(config, [new Provider()], { presentedImageDirectory: join(__dirname, "saved") });
let bridge = makeBridge(), router = new BridgeRequestRouter(bridge), counter = 0;
app.whenReady().then(async () => {
  const source = join(__dirname, "temporary image.png");
  await copyFile(process.argv[2]!, source);
  await bridge.start();
  const sessionId = (await bridge.refresh()).sessions[0]!.id;
  const window = new BrowserWindow({ show: false, width: 1000, height: 760,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true } });
  ipcMain.handle("qa:request", async (_event, type, payload) => {
    if (type === "session.image.get") await new Promise(resolve => setTimeout(resolve, 150));
    return await router.handle({ protocolVersion: CURRENT_PROTOCOL_VERSION, kind: "request", hostId,
      messageId: String(++counter), requestId: String(counter), sentAt: new Date().toISOString(), type, payload });
  });
  ipcMain.handle("qa:present", async () => {
    const input = { path: source, request_id: "mounted-image" };
    await bridge.executeClientTool(sessionId, "tethoq_show_image", input);
    await bridge.executeClientTool(sessionId, "tethoq_show_image", input);
    return sessionId;
  });
  ipcMain.handle("qa:restart", async () => {
    await bridge.dispose();
    await unlink(source);
    bridge = makeBridge();
    await bridge.start();
    await bridge.refresh();
    router = new BridgeRequestRouter(bridge);
  });
  ipcMain.handle("qa:capture", async () => {
    if (process.env.TETHOQ_IMAGE_QA_SCREENSHOT) await writeFile(process.env.TETHOQ_IMAGE_QA_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
  });
  await window.loadFile(join(__dirname, "index.html"));
  let result;
  for (let i = 0; i < 400; i++) {
    result = await window.webContents.executeJavaScript("window.__imageResult");
    if (result) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  process.stdout.write("IMAGE_QA=" + JSON.stringify(result ?? { ok: false, error: "Timed out" }) + "\n");
  await bridge.dispose();
  window.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
