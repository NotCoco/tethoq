import assert from "node:assert/strict";
import test from "node:test";
import { createHostIdentity, type RemoteMessage } from "../../../packages/protocol/src/index.js";
import { visibleContextTransferText } from "../../../packages/protocol/src/context_visibility.js";
import { FakeProviderAdapter } from "../../../packages/provider_fake/src/index.js";
import { providerPromptContent, stripProviderPromptGuidance, type SendMessageRequest, type SendMessageResult } from "../../../packages/provider_contract/src/index.js";
import { AgentBridge } from "./bridge.js";
import { clientVisibleBranchMessages } from "./context_transfer.js";

const bootstrap = '[[TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1]]\nPrivate transcript\n{"messages":[]}\n';
const request = "[[TETHOQ_BRANCH_USER_REQUEST_V1]]\nSide chat!";

test("private transfer echoes stay hidden through streaming, split parts, and provider guidance", () => {
  for (const prefix of [bootstrap, "[[TETHOQ_BRANCH_TRANSCRIPT", "[[TETHOQ_CONTEXT_HANDOFF_V1]]\nPrivate summary", "<tethoq_response_guidance>\nPrivate context"]) {
    assert.equal(visibleContextTransferText(prefix), "");
  }
  assert.equal(visibleContextTransferText(bootstrap + request), "Side chat!");
  assert.equal(visibleContextTransferText("[[TETHOQ_CONTEXT_HANDOFF_V1]]\r\nSummary\r\n[[TETHOQ_CONTEXT_HANDOFF_USER_REQUEST_V1]]\r\nContinue"), "Continue");
  assert.equal(stripProviderPromptGuidance(providerPromptContent({ content: bootstrap + request, developerInstructions: "Role guidance" })), "Side chat!");
  for (const literal of ["Ordinary request", "Explain [[TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1]]", "```text\n" + bootstrap + "```", "`[[TETHOQ_BRANCH_TRANSCRIPT_BOOTSTRAP_V1]]`"]) {
    assert.equal(visibleContextTransferText(literal), literal);
  }
  const message: RemoteMessage = { id: "echo", sessionId: "side", providerMessageId: "echo", role: "user", createdAt: new Date().toISOString(), status: "completed", nativeMetadata: {}, parts: [
    { type: "text", text: bootstrap.slice(0, 20) },
    { type: "text", text: bootstrap.slice(20) + request },
    { type: "image", uri: "attachment.png", name: "Attachment" },
  ] };
  assert.deepEqual(clientVisibleBranchMessages([message])[0]!.parts, [{ type: "text", text: "Side chat!" }, message.parts[2]]);
  assert.deepEqual(clientVisibleBranchMessages([{ ...message, parts: [{ type: "text", text: bootstrap }] }]), []);
});

test("side-chat context stays private and remains available on follow-up turns", async (t) => {
  class CapturingProvider extends FakeProviderAdapter {
    readonly sends: SendMessageRequest[] = [];
    override async sendMessage(_sessionId: string, input: SendMessageRequest): Promise<SendMessageResult> {
      this.sends.push(input);
      return { accepted: true, details: [] };
    }
  }
  const hostId = "private-side-chat";
  const provider = new CapturingProvider({ hostId, sessionCount: 1 });
  const bridge = new AgentBridge({ version: 1, hostId, displayName: "Private context check", identity: createHostIdentity(), enabledProviders: [provider.providerId] }, [provider]);
  t.after(() => bridge.dispose());
  await bridge.start();
  const parent = (await bridge.refresh()).sessions[0]!;
  const side = await bridge.createSideChat(parent.id, "Prepare a pickup prompt.");
  await bridge.sendMessage(side.session.id, { requestId: "follow-up", content: "Include the remaining work." });
  assert.deepEqual(provider.sends.map((send) => send.content), ["Prepare a pickup prompt.", "Include the remaining work."]);
  for (const send of provider.sends) {
    assert.match(send.developerInstructions!, /Seed message for fixture 1/);
    assert.match(send.developerInstructions!, /private background context/);
    assert.equal(stripProviderPromptGuidance(providerPromptContent(send)), send.content);
  }
});
