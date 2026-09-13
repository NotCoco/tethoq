import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const appRoot = join(testDirectory, "..");
const electronPath = createRequire(import.meta.url)("electron");
const inlineWorkerStubPlugin = {
  name: "inline-worker-stub",
  setup(buildContext) {
    buildContext.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: "inline-worker-stub" }));
    buildContext.onLoad({ filter: /.*/, namespace: "inline-worker-stub" }, () => ({
      contents: "export default class InlineWorkerStub { constructor() { throw new Error('Workers are not started by side-chat lifecycle tests'); } }",
      loader: "js",
    }));
  },
};

function runElectron(mainPath, htmlPath) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [mainPath, htmlPath], {
      cwd: appRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Mounted side-chat QA timed out.\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) { reject(new Error(`Mounted side-chat QA exited ${code}.\n${stderr}\n${stdout}`)); return; }
      const marker = stdout.split(/\r?\n/u).find((line) => line.startsWith("TETHOQ_SIDE_CHAT_QA="));
      if (!marker) { reject(new Error(`Mounted side-chat QA returned no result.\n${stderr}\n${stdout}`)); return; }
      resolve(JSON.parse(marker.slice("TETHOQ_SIDE_CHAT_QA=".length)));
    });
  });
}

test("mounted side chat focuses, dismisses without deletion, and reopens from the opted-in task rail", { timeout: 40_000 }, async () => {
  const outputDirectory = join(tmpdir(), `tethoq-side-chat-mounted-${process.pid}-${Date.now()}`);
  const rendererBundle = join(outputDirectory, "renderer.js");
  const htmlPath = join(outputDirectory, "index.html");
  const mainPath = join(outputDirectory, "main.cjs");
  await mkdir(outputDirectory, { recursive: true });
  try {
    await build({
      stdin: {
        resolveDir: appRoot,
        sourcefile: "side-chat-mounted-qa.tsx",
        loader: "tsx",
        contents: String.raw`
          import React from "react";
          import { createRoot } from "react-dom/client";

          globalThis.IS_REACT_ACT_ENVIRONMENT = false;
          window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 0);
          window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
          window.tethoqDesktop = {
            request: async () => ({ ok: true, payload: { sessions: [] } }),
            selectImages: async () => [],
          };

          const [{ SideChatPanel, mergeFailedSideChatDraft }, { Sidebar }, { sessionsForTaskListMode }, { mergeAcceptedComposerRow, mergeTimeline, rollbackOptimisticComposerRow }, { DesktopBridgeRequestError }] = await Promise.all([
            import("./src/renderer/src/Composer.tsx"),
            import("./src/renderer/src/NavigationPanels.tsx"),
            import("./src/renderer/src/session_projects.ts"),
            import("./src/renderer/src/timeline_merge.ts"),
            import("./src/renderer/src/bridge.ts"),
          ]);
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const settle = async (count = 3) => { for (let index = 0; index < count; index += 1) { await new Promise((resolve) => setTimeout(resolve, 0)); await frame(); } };
          const check = (condition, message) => { if (!condition) throw new Error(message); };
          const element = (selector, label = selector) => { const value = document.querySelector(selector); check(value, label + " is missing"); return value; };
          const setTextarea = async (value, next) => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(value, next);
            value.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: next }));
            await settle();
          };
          const provider = {
            id: "codex", name: "Codex", state: "online", detected: true, supportsAttachments: true,
            capabilities: ["Create Session", "Send Message", "Session History"],
          };
          const parent = {
            id: "parent-task", providerId: "codex", title: "Parent task", state: "idle", project: "project",
            workingDirectory: "C:\\project", preview: "Parent preview", updatedAt: "2026-08-25T12:00:00.000Z", model: "gpt-5.6-sol", effort: "medium",
          };
          const sideChat = {
            ...parent, id: "created-side-chat", title: "Side chat", preview: "Stored side-chat question",
            sessionKind: "side_chat", parentSessionId: parent.id, updatedAt: "2026-08-25T12:03:00.000Z",
          };
          const relationshipSideChat = {
            ...parent, id: "relationship-side-chat", title: "Restored side chat", preview: "Stored by relationship",
            sessionKind: "task", relationshipKind: "side_chat", relationshipSourceSessionId: parent.id, updatedAt: "2026-08-25T12:02:00.000Z",
          };
          const olderSideChat = {
            ...sideChat, id: "older-side-chat", title: "Older side chat", preview: "Third stored side chat", updatedAt: "2026-08-25T12:01:00.000Z",
          };
          const promoted = {
            ...parent, id: "promoted-task", title: "Promoted findings", preview: "Copied from side chat",
            sessionKind: "task", updatedAt: "2026-08-25T12:02:00.000Z",
          };
          const opener = document.createElement("button");
          opener.textContent = "Open side chat";
          document.body.append(opener);
          const outsideTarget = document.createElement("button");
          outsideTarget.textContent = "Outside target";
          document.body.append(outsideTarget);
          const textareaFocusOptions = [];
          const nativeTextareaFocus = HTMLTextAreaElement.prototype.focus;
          HTMLTextAreaElement.prototype.focus = function(options) {
            if (this.getAttribute("aria-label") === "Side chat message") textareaFocusOptions.push(options);
            return nativeTextareaFocus.call(this, options);
          };
          let mounted = null;
          let retainedDraft = { content: "", attachments: [] };
          const unmount = async () => {
            if (!mounted) return;
            mounted.root.unmount();
            mounted.host.remove();
            mounted = null;
            await settle(1);
          };
          const mountPanel = async (timeline = []) => {
            await unmount();
            opener.focus();
            const host = document.createElement("div");
            document.body.append(host);
            let closeCount = 0;
            let discardCount = 0;
            const root = createRoot(host);
            const Harness = () => {
              const [open, setOpen] = React.useState(true);
              const [draft, setDraft] = React.useState(retainedDraft);
              return open ? <SideChatPanel
                session={sideChat} provider={provider} timeline={timeline} draft={draft}
                request={async () => ({})} selectImages={async () => []} notify={() => undefined}
                sending={false} onSendStarted={() => true} onSendSettled={() => undefined}
                onDraftChange={(update) => { retainedDraft = typeof update === "function" ? update(retainedDraft) : update; setDraft(retainedDraft); }} onDiscardDraft={() => { discardCount += 1; retainedDraft = { content: "", attachments: [] }; setDraft(retainedDraft); }} onSent={() => undefined} onSendFailed={() => true}
                onClose={() => { closeCount += 1; setOpen(false); }} onPromote={async () => undefined}
              /> : null;
            };
            root.render(<Harness />);
            mounted = { root, host, closeCount: () => closeCount, discardCount: () => discardCount };
            await settle(5);
            return mounted;
          };
          const mountSendPanel = async (selectedAttachmentBatches) => {
            await unmount();
            retainedDraft = { content: "", attachments: [] };
            opener.focus();
            const host = document.createElement("div");
            document.body.append(host);
            const calls = [];
            const notifications = [];
            let selectionIndex = 0;
            let uploadIndex = 0;
            let pendingDelivery = null;
            let renderedTimeline = [];
            let renderedSession = { ...sideChat, state: "idle" };
            let renderedSending = false;
            let sendLocked = false;
            let commitTimeline = null;
            const request = async (type, payload = {}) => {
              calls.push({ type, payload });
              if (type === "attachment.upload.begin") return { uploadId: "side-upload-" + (++uploadIndex), chunkBytes: 32768 };
              if (type === "attachment.upload.complete") return { attachmentId: "side-attachment-" + uploadIndex };
              if (type === "session.send_message") return await new Promise((resolve, reject) => { pendingDelivery = { resolve, reject }; });
              return {};
            };
            const root = createRoot(host);
            const Harness = () => {
              const [currentTimeline, setCurrentTimeline] = React.useState([]);
              const [currentSession, setCurrentSession] = React.useState(renderedSession);
              const [draft, setDraft] = React.useState(retainedDraft);
              const [sending, setSending] = React.useState(false);
              const [open, setOpen] = React.useState(true);
              renderedTimeline = currentTimeline;
              renderedSession = currentSession;
              renderedSending = sending;
              commitTimeline = setCurrentTimeline;
              return <><button type="button" aria-label="Reopen transaction side chat" onClick={() => setOpen(true)}>Reopen side chat</button>{open ? <SideChatPanel
                session={currentSession} provider={provider} timeline={currentTimeline} draft={draft}
                sending={sending}
                request={request} selectImages={async () => { const selected = selectedAttachmentBatches[selectionIndex++] ?? []; if (selected instanceof Error) throw selected; return selected; }}
                notify={(message, tone) => { notifications.push({ message, tone }); }}
                onDraftChange={(update) => {
                  retainedDraft = typeof update === "function" ? update(retainedDraft) : update;
                  setDraft(retainedDraft);
                }}
                onDiscardDraft={() => { retainedDraft = { content: "", attachments: [] }; setDraft(retainedDraft); }}
                onSendStarted={() => {
                  if (sendLocked) return false;
                  sendLocked = true;
                  setSending(true);
                  return true;
                }}
                onSendSettled={() => {
                  if (!sendLocked) return;
                  sendLocked = false;
                  setSending(false);
                }}
                onSent={(item, userRowIdsBeforeDelivery) => {
                  setCurrentTimeline((current) => mergeAcceptedComposerRow(current, item, userRowIdsBeforeDelivery));
                  setCurrentSession((current) => ({ ...current, preview: item.body, state: "working", updatedAt: item.timestamp }));
                }}
                onSendFailed={(presentationId, optimisticTimestamp, submittedDraft) => {
                  const observedPresentation = renderedTimeline.find((item) => item.id === presentationId || item.presentationId === presentationId);
                  if (observedPresentation?.presentationId === presentationId && observedPresentation.id !== presentationId) return false;
                  retainedDraft = mergeFailedSideChatDraft(submittedDraft, retainedDraft);
                  setDraft(retainedDraft);
                  setCurrentTimeline((current) => rollbackOptimisticComposerRow(current, presentationId));
                  setCurrentSession((current) => current.updatedAt === optimisticTimestamp
                    ? { ...current, state: "idle", preview: sideChat.preview, updatedAt: sideChat.updatedAt }
                    : current);
                  return true;
                }}
                onClose={() => setOpen(false)} onPromote={async () => undefined}
              /> : null}</>;
            };
            root.render(<Harness />);
            mounted = { root, host };
            await settle(5);
            return {
              calls,
              notifications,
              draft: () => retainedDraft,
              timeline: () => renderedTimeline,
              session: () => renderedSession,
              sending: () => renderedSending,
              deliveryPending: () => pendingDelivery !== null,
              injectTimeline: async (item) => {
                check(commitTimeline, "Mounted side-chat timeline updater is unavailable");
                commitTimeline((current) => mergeTimeline(current, item));
                await settle();
              },
              resolveDelivery: (value = {}) => { check(pendingDelivery, "Deferred side-chat delivery resolver is unavailable"); const pending = pendingDelivery; pendingDelivery = null; pending.resolve(value); },
              rejectDelivery: (error) => { check(pendingDelivery, "Deferred side-chat delivery rejecter is unavailable"); const pending = pendingDelivery; pendingDelivery = null; pending.reject(error); },
            };
          };

          try {
            const firstFocusCount = textareaFocusOptions.length;
            let panel = await mountPanel();
            check(document.activeElement === element('textarea[aria-label="Side chat message"]'), "Opening did not focus the side-chat textarea");
            check(textareaFocusOptions.length === firstFocusCount + 1 && textareaFocusOptions.at(-1)?.preventScroll === true, "Opening did not focus exactly once with preventScroll");
            check(Boolean(document.querySelector('button[aria-label="Close side chat"]')), "Empty side chat did not keep Close visible");
            check(!document.querySelector('button[aria-label="Side chat actions"]'), "Empty side chat exposed an actionless overflow menu");
            check(!document.querySelector('button[aria-label="Send findings to the parent task"]'), "Empty side chat exposed promotion before it had findings");
            const sideChatField = document.activeElement;
            const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
            valueSetter.call(sideChatField, "Retain this draft");
            sideChatField.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Retain this draft" }));
            await settle();
            const draftActions = element('button[aria-label="Side chat actions"]', "Draft side-chat actions");
            check(!document.querySelector('button[aria-label="Send findings to the parent task"]'), "An unsent draft incorrectly enabled promotion");
            draftActions.click();
            await settle();
            check(Boolean([...document.querySelectorAll('.side-chat-panel [role="menuitem"]')].find((candidate) => candidate.textContent?.includes("Discard draft"))), "Draft menu did not offer discard");
            check(![...document.querySelectorAll('.side-chat-panel [role="menuitem"]')].some((candidate) => candidate.textContent?.includes("Copy to full task")), "Draft-only menu offered meaningless promotion");
            draftActions.click();
            await settle();
            sideChatField.focus();
            document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            await settle();
            check(!document.querySelector('[role="dialog"][aria-label="Side chat"]'), "Escape did not hide the side chat");
            check(panel.closeCount() === 1, "Escape did not request exactly one close");
            check(panel.discardCount() === 0, "Escape discarded the stored side chat");
            check(document.activeElement === opener, "Escape did not return focus to the side-chat opener");

            panel = await mountPanel();
            check(element('textarea[aria-label="Side chat message"]').value === "Retain this draft", "Reopening discarded the side-chat draft");
            outsideTarget.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
            outsideTarget.focus();
            await settle();
            check(!document.querySelector('[role="dialog"][aria-label="Side chat"]'), "Outside pointer did not hide the side chat");
            check(panel.closeCount() === 1, "Outside pointer did not request exactly one close");
            check(panel.discardCount() === 0, "Outside pointer discarded the stored side chat");
            check(document.activeElement === outsideTarget, "Outside dismissal stole focus from the deliberate target");

            panel = await mountPanel();
            element('button[aria-label="Close side chat"]').click();
            await settle();
            check(!document.querySelector('[role="dialog"][aria-label="Side chat"]'), "Close control did not hide the side chat");
            check(panel.closeCount() === 1 && panel.discardCount() === 0, "Close control did not use the hide-only path");
            check(document.activeElement === opener, "Close control did not return focus to the opener");

            retainedDraft = { content: "", attachments: [] };
            panel = await mountPanel([{ id: "own-side-chat-question", kind: "user", body: "A real side-chat question", timestamp: "2026-08-25T12:04:00.000Z", state: "completed" }]);
            check(Boolean(document.querySelector('button[aria-label="Close side chat"]')), "Populated side chat lost its permanent Close control");
            check(Boolean(document.querySelector('button[aria-label="Side chat actions"]')), "Populated side chat did not expose its overflow actions");
            check(Boolean(document.querySelector('button[aria-label="Send findings to the parent task"]')), "Populated side chat did not expose promotion");
            element('button[aria-label="Side chat actions"]').click();
            await settle();
            check(Boolean([...document.querySelectorAll('.side-chat-panel [role="menuitem"]')].find((candidate) => candidate.textContent?.includes("Copy to full task"))), "Populated side-chat menu omitted promotion");
            check(![...document.querySelectorAll('.side-chat-panel [role="menuitem"]')].some((candidate) => candidate.textContent?.includes("Discard draft")), "No-draft side chat exposed discard");

            const submittedImage = {
              name: "submitted.png", path: "C:\\qa\\submitted.png", mimeType: "image/png",
              byteLength: 1, dataBase64: "AQ==", origin: "file-picker",
            };
            let transaction = await mountSendPanel([
              Array.from({ length: 12 }, (_, index) => ({ ...submittedImage, name: "side-" + index + ".png", path: "side-" + index })),
              [submittedImage],
              new Error("Choose up to 12 files at a time"),
            ]);
            element('button[aria-label="Attach image"]').click();
            await settle(5);
            check(transaction.draft().attachments.length === 12, "Side chat did not accept twelve images");
            element('button[aria-label="Attach image"]').click();
            await settle(5);
            check(transaction.draft().attachments.length === 12, "Side chat accepted a thirteenth image");
            check(transaction.notifications.some(item => item.message.includes("up to 12 items")), "Side chat did not explain its attachment limit");
            element('button[aria-label="Attach image"]').click();
            await settle(5);
            check(transaction.notifications.some(item => item.message === "Choose up to 12 files at a time"), "Side chat swallowed the native picker error");
            check(transaction.draft().attachments.length === 12, "Side chat lost attachments after picker rejection");

            transaction = await mountSendPanel([[submittedImage]]);
            let transactionField = element('textarea[aria-label="Side chat message"]');
            await setTextarea(transactionField, "Send this side-chat prompt exactly once");
            element('button[aria-label="Attach image"]').click();
            await settle();
            check(Boolean(document.querySelector('button[aria-label="Remove submitted.png"]')), "Selected side-chat image did not enter the draft");
            const transactionSend = element('button[aria-label="Send side chat message"]');
            transactionSend.click();
            transactionSend.click();
            transactionField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            await settle(6);
            check(transaction.deliveryPending(), "Side-chat delivery did not remain controllably unresolved");
            check(transaction.calls.filter((call) => call.type === "session.send_message").length === 1, "Rapid side-chat click and Enter submitted more than one delivery");
            check(transactionField.value === "", "Side-chat text did not clear before provider acknowledgement");
            check(!document.querySelector('.side-chat-attachments'), "Side-chat attachments did not clear before provider acknowledgement");
            check(document.querySelectorAll('.side-chat-transcript .message-user').length === 1, "Pending side-chat send did not paint exactly one user row");
            check(element('.side-chat-transcript .message-user .message-body').textContent === "Send this side-chat prompt exactly once", "Pending side-chat row lost the submitted text");
            check(Boolean(document.querySelector('.side-chat-transcript .working-pulse[aria-busy]')), "Pending side-chat send did not paint the active reasoning shimmer");
            check(Boolean(document.querySelector('.side-chat-send .spinner')), "Pending side-chat send did not paint its loading spinner");
            check(transaction.session().state === "working", "Pending side-chat send did not expose immediate working state");

            const canonicalEcho = {
              id: "canonical-side-chat-user", messageId: "canonical-side-chat-message", kind: "user",
              body: "Send this side-chat prompt exactly once", timestamp: new Date().toISOString(), state: "completed",
              images: [{ name: "submitted.png", mimeType: "image/png", loading: true }],
            };
            await transaction.injectTimeline(canonicalEcho);
            check(transaction.timeline().length === 1 && transaction.timeline()[0].id === canonicalEcho.id, "Canonical side-chat echo did not adopt the optimistic presentation");
            check(document.querySelectorAll('.side-chat-transcript .message-user').length === 1, "Canonical side-chat echo duplicated the mounted user row");
            check(Boolean(document.querySelector('.side-chat-transcript img[alt="submitted.png"]')), "Canonical side-chat echo lost the immediate attachment preview");
            transaction.rejectDelivery(new Error("Transport acknowledgement timed out"));
            await settle(6);
            check(document.querySelectorAll('.side-chat-transcript .message-user').length === 1 && transaction.timeline()[0].id === canonicalEcho.id, "Late request rejection retracted or duplicated the canonical user row");
            check(transaction.draft().content === "" && transaction.draft().attachments.length === 0, "Late request rejection restored a duplicate of the canonically accepted prompt");
            check(transaction.session().state === "working", "Late request rejection overrode canonical provider working state");
            check(!transaction.sending() && !document.querySelector('.side-chat-send .spinner'), "Late request rejection did not release only the local send lock");
            check(transaction.notifications.length === 0, "Late request rejection surfaced a false failure after canonical acceptance");
            check(!transaction.calls.some((call) => call.type === "attachment.upload.cancel"), "Late request rejection cancelled the canonically accepted attachment");

            const attachmentOnlyImage = {
              name: "attachment-only.png", path: "C:\\qa\\attachment-only.png", mimeType: "image/png",
              byteLength: 1, dataBase64: "BA==", origin: "file-picker",
            };
            transaction = await mountSendPanel([[attachmentOnlyImage]]);
            transactionField = element('textarea[aria-label="Side chat message"]');
            check(element('button[aria-label="Send side chat message"]').disabled, "Empty attachment-free side chat enabled Send");
            transactionField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            await settle();
            check(!transaction.deliveryPending() && !transaction.calls.some((call) => call.type === "session.send_message"), "Empty attachment-free side-chat Enter bypassed the submit guard");
            element('button[aria-label="Attach image"]').click();
            await settle();
            check(!element('button[aria-label="Send side chat message"]').disabled, "Attachment-only side chat did not enable Send");
            transactionField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            await settle(6);
            const attachmentOnlyCalls = transaction.calls.filter((call) => call.type === "session.send_message");
            check(transaction.deliveryPending() && attachmentOnlyCalls.length === 1, "Attachment-only side-chat Enter did not submit exactly once");
            check(attachmentOnlyCalls[0].payload.content === "", "Attachment-only side chat synthesized message text");
            check(attachmentOnlyCalls[0].payload.attachmentIds?.length === 1, "Attachment-only side chat did not forward its uploaded attachment");
            check(transaction.timeline().length === 1 && transaction.timeline()[0].body === "", "Attachment-only side chat did not paint one text-free optimistic row");
            check(Boolean(document.querySelector('.side-chat-transcript img[alt="attachment-only.png"]')), "Attachment-only optimistic row lost its preview");
            transaction.resolveDelivery();
            await settle(6);
            check(!transaction.sending(), "Accepted attachment-only side chat did not release the send lock");
            await setTextarea(transactionField, "Keep this follow-up drafted while the turn is active");
            check(element('button[aria-label="Send side chat message"]').disabled, "An acknowledged active side-chat turn enabled a second ordinary Send");
            transactionField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            await settle();
            check(transactionField.value === "Keep this follow-up drafted while the turn is active", "Blocked active-turn Enter discarded the side-chat follow-up draft");
            check(transaction.calls.filter((call) => call.type === "session.send_message").length === 1, "Blocked active-turn Enter submitted a second ordinary side-chat message");
            check(transaction.notifications.some((notification) => notification.tone === "error" && notification.message === "Wait for this side chat to finish before sending another message."), "Blocked active-turn Enter did not explain why the follow-up remained drafted");

            const unknownImage = {
              name: "unknown.png", path: "C:\\qa\\unknown.png", mimeType: "image/png",
              byteLength: 1, dataBase64: "BA==", origin: "file-picker",
            };
            transaction = await mountSendPanel([[unknownImage]]);
            transactionField = element('textarea[aria-label="Side chat message"]');
            await setTextarea(transactionField, "Keep this ambiguous side-chat submission visible");
            element('button[aria-label="Attach image"]').click();
            await settle();
            element('button[aria-label="Send side chat message"]').click();
            await settle(6);
            transaction.rejectDelivery(new DesktopBridgeRequestError({
              code: "DELIVERY_UNKNOWN",
              message: "The side-chat acknowledgement was lost",
              retryable: false,
            }));
            await settle(8);
            check(transaction.timeline().length === 1 && transaction.timeline()[0].body === "Keep this ambiguous side-chat submission visible", "Ambiguous side-chat delivery retracted its optimistic user row");
            check(transaction.timeline()[0].images?.[0]?.name === "unknown.png", "Ambiguous side-chat delivery lost its submitted attachment presentation");
            check(transaction.draft().content === "" && transaction.draft().attachments.length === 0, "Ambiguous side-chat delivery restored the submitted composition");
            check(!document.querySelector('.side-chat-attachments'), "Ambiguous side-chat delivery repainted a consumed attachment chip");
            check(transaction.session().state === "working", "Ambiguous side-chat delivery rolled back its optimistic working state");
            check(!transaction.sending() && !document.querySelector('.side-chat-send .spinner'), "Ambiguous side-chat delivery did not release only its local send lock");
            check(!transaction.calls.some((call) => call.type === "attachment.upload.cancel"), "Ambiguous side-chat delivery cancelled an upload that the provider may own");
            check(transaction.notifications.some((notification) => notification.tone === "error" && notification.message === "The side-chat acknowledgement was lost"), "Ambiguous side-chat delivery did not surface its unresolved status");

            const failedImage = {
              name: "failed.png", path: "C:\\qa\\failed.png", mimeType: "image/png",
              byteLength: 1, dataBase64: "Ag==", origin: "file-picker",
            };
            const newerImage = {
              name: "newer.png", path: "C:\\qa\\newer.png", mimeType: "image/png",
              byteLength: 1, dataBase64: "Aw==", origin: "file-picker",
            };
            transaction = await mountSendPanel([[failedImage], [newerImage]]);
            transactionField = element('textarea[aria-label="Side chat message"]');
            await setTextarea(transactionField, "Restore this failed side-chat prompt");
            element('button[aria-label="Attach image"]').click();
            await settle();
            element('button[aria-label="Send side chat message"]').click();
            await settle(6);
            check(transaction.deliveryPending(), "Failed side-chat QA never reached its deferred provider request");
            check(document.querySelectorAll('.side-chat-transcript .message-user').length === 1, "Pending failed side-chat send did not paint its optimistic row");
            element('button[aria-label="Close side chat"]').click();
            await settle();
            check(!document.querySelector('[role="dialog"][aria-label="Side chat"]'), "Closing a pending side-chat send did not unmount its panel");
            element('button[aria-label="Reopen transaction side chat"]').click();
            await settle(5);
            transactionField = element('textarea[aria-label="Side chat message"]');
            check(transactionField.value === "", "Reopened pending side chat resurrected the already-submitted draft");
            check(element('button[aria-label="Send side chat message"]').disabled && Boolean(document.querySelector('.side-chat-send .spinner')), "Reopened pending side chat lost its App-owned send lock");
            await setTextarea(transactionField, "New draft typed while waiting");
            element('button[aria-label="Attach image"]').click();
            await settle(5);
            check(transaction.draft().attachments.map((attachment) => attachment.name).join(",") === "newer.png", "Newer side-chat attachment was not retained during delivery");
            transactionField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            element('button[aria-label="Send side chat message"]').click();
            await settle();
            check(transaction.calls.filter((call) => call.type === "session.send_message").length === 1, "Reopened pending side chat allowed a duplicate send");
            transaction.rejectDelivery(new Error("Provider rejected the side-chat send"));
            await settle(8);
            check(transactionField.value === "Restore this failed side-chat prompt\n\nNew draft typed while waiting", "Failure did not restore submitted side-chat text ahead of newer typing");
            check(transaction.draft().attachments.map((attachment) => attachment.name).join(",") === "failed.png,newer.png", "Failure did not restore submitted and newer side-chat attachments together");
            check(Boolean(document.querySelector('button[aria-label="Remove failed.png"]')) && Boolean(document.querySelector('button[aria-label="Remove newer.png"]')), "Failure did not repaint both side-chat attachment chips");
            check(document.querySelectorAll('.side-chat-transcript .message-user').length === 0, "Definite side-chat failure did not retract its optimistic row");
            check(!document.querySelector('.side-chat-transcript .working-pulse'), "Definite side-chat failure left the reasoning shimmer active");
            check(transaction.session().state === "idle", "Definite side-chat failure left the session in optimistic working state");
            check(!element('button[aria-label="Send side chat message"]').disabled, "Definite side-chat failure left the restored draft locked");
            const providerRejectionErrors = transaction.notifications.filter((notification) => notification.tone === "error" && notification.message === "Provider rejected the side-chat send");
            check(providerRejectionErrors.length === 1, "Definite side-chat failure did not surface its provider error exactly once");
            check(transaction.calls.filter((call) => call.type === "session.send_message").length === 1, "Failed side-chat transaction submitted more than once");

            await unmount();
            const host = document.createElement("div");
            document.body.append(host);
            let reopenedId = null;
            let reopenedAnchor = null;
            let reportedAnchor = null;
            const root = createRoot(host);
            const RailHarness = () => {
              const [showSideChats, setShowSideChats] = React.useState(false);
              const [taskListMode, setTaskListMode] = React.useState("recent");
              const [activeSideChatIds, setActiveSideChatIds] = React.useState([]);
              const allStoredSessions = [parent, sideChat, relationshipSideChat, olderSideChat];
              return <Sidebar
                sessions={sessionsForTaskListMode(allStoredSessions, taskListMode)} allSessions={allStoredSessions} providers={[provider]} selected={parent.id}
                selectedProvider="all" query="" stateFilter="all" view="workspace" connected={true} hostName="QA" appVersion="0.1.0"
                onQuery={() => undefined} onFilter={() => undefined} onProvider={() => undefined} onOpen={() => undefined}
                onOpenChild={() => undefined} onBranch={() => undefined} onOpenDirectory={() => undefined} onView={() => undefined}
                onNewTask={() => undefined} onNewTaskInProject={() => undefined} onNewProject={() => undefined}
                taskListMode={taskListMode} savedProjectDirectories={[parent.workingDirectory]} onTaskListMode={setTaskListMode} onCommandSearch={() => undefined}
                showSideChats={showSideChats} activeSideChatIds={activeSideChatIds} onShowSideChats={setShowSideChats}
                onCreateSideChat={async () => undefined} onOpenSideChat={(id, anchor) => { reopenedId = id; reopenedAnchor = anchor; setActiveSideChatIds([id]); }} onSideChatAnchor={(id, anchor) => { if (id === sideChat.id) reportedAnchor = anchor; }}
                showArchived={false} archivedCount={0} onShowArchived={() => undefined} onTaskOverride={() => undefined}
              />;
            };
            root.render(<RailHarness />);
            mounted = { root, host };
            await settle();
            element('button.sidebar-task-filter').click();
            await settle();
            const showButton = [...document.querySelectorAll('[role="dialog"][aria-label="Task filters"] [role="checkbox"]')]
              .find((candidate) => candidate.textContent?.includes("Show side chats"));
            check(showButton instanceof HTMLButtonElement, "Show side chats filter is missing");
            showButton.click();
            await settle();
            const child = element('button[data-side-chat-id="created-side-chat"]', "Opted-in side-chat row");
            check(Boolean(document.querySelector('button[data-side-chat-id="relationship-side-chat"]')), "Relationship-backed side chat was not nested in the rich recent row");
            check(!document.querySelector('[data-session-id="relationship-side-chat"]'), "Relationship-backed side chat leaked into the top-level recent list");
            child.click();
            await settle();
            check(reopenedId === sideChat.id, "The stored side-chat row did not reopen its chat");
            const parentBounds = element('[data-session-id="parent-task"]', "Parent task anchor").getBoundingClientRect();
            const parentCenterY = parentBounds.top + parentBounds.height / 2;
            check(reopenedAnchor && Math.abs(reopenedAnchor.y - parentCenterY) < 0.5, "Reopening shifted the side chat away from its parent task row");
            check(reportedAnchor && Math.abs(reportedAnchor.y - parentCenterY) < 0.5, "Active side-chat geometry drifted from its parent task row");
            const railToggle = element('button[aria-label="Hide side chats for Parent task"]', "Side-chat rail disclosure");
            check(railToggle.getAttribute("aria-expanded") === "true", "Expanded side-chat rail did not announce its state");
            const controlledRegionId = railToggle.getAttribute("aria-controls") || "";
            check(Boolean(controlledRegionId), "Side-chat rail disclosure does not name its controlled region");
            railToggle.click();
            await settle();
            check(railToggle.getAttribute("aria-expanded") === "false", "Side-chat rail did not collapse");
            check(element('#' + CSS.escape(controlledRegionId), "Collapsed side-chat region").hidden, "Collapsed side-chat rows remained visible");
            check(Boolean(document.querySelector('.session-row-group.side-chats-collapsed')), "Collapsed side-chat tab did not remain attached to the parent");
            railToggle.click();
            await settle();
            check(railToggle.getAttribute("aria-expanded") === "true", "Side-chat rail did not reopen");
            check(!element('#' + CSS.escape(controlledRegionId), "Reopened side-chat region").hidden, "Reopened side-chat rows remained hidden");

            element('button[aria-label="Arrange tasks by project"]').click();
            await settle();
            check(Boolean(document.querySelector('button[data-side-chat-id="created-side-chat"]')), "Compact project rendering suppressed the opted-in side-chat row");
            check(Boolean(document.querySelector('button[data-side-chat-id="relationship-side-chat"]')), "Compact project rendering suppressed the relationship-backed side-chat row");
            check(!document.querySelector('button[data-side-chat-id="older-side-chat"]'), "Compact project row ignored its initial side-chat limit");
            element('button[aria-label="Show all side chats"]', "Compact side-chat expansion control").click();
            await settle();
            check(Boolean(document.querySelector('button[data-side-chat-id="older-side-chat"]')), "Compact project row could not reveal every stored side chat");
            element('button[aria-label="Hide side chats for Parent task"]', "Project side-chat rail disclosure").click();
            await settle();
            element('button[aria-label="Show side chats for Parent task"]', "Collapsed project side-chat rail disclosure").click();
            await settle();
            check(Boolean(document.querySelector('button[data-side-chat-id="older-side-chat"]')), "Collapse and reopen forgot the Show all side-chat choice");

            await unmount();
            const promotedHost = document.createElement("div");
            document.body.append(promotedHost);
            let openedTaskId = null;
            const promotedRoot = createRoot(promotedHost);
            promotedRoot.render(<Sidebar
              sessions={[promoted, parent]} allSessions={[promoted, parent, sideChat]} providers={[provider]} selected={parent.id}
              selectedProvider="all" query="" stateFilter="all" view="workspace" connected={true} hostName="QA" appVersion="0.1.0"
              onQuery={() => undefined} onFilter={() => undefined} onProvider={() => undefined} onOpen={(id) => { openedTaskId = id; }}
              onOpenChild={() => undefined} onBranch={() => undefined} onOpenDirectory={() => undefined} onView={() => undefined}
              onNewTask={() => undefined} onNewTaskInProject={() => undefined} onNewProject={() => undefined}
              taskListMode="recent" onTaskListMode={() => undefined} onCommandSearch={() => undefined}
              showSideChats={false} activeSideChatIds={[]} onShowSideChats={() => undefined}
              onCreateSideChat={async () => undefined} onOpenSideChat={() => undefined} onSideChatAnchor={() => undefined}
              showArchived={false} archivedCount={0} onShowArchived={() => undefined} onTaskOverride={() => undefined}
            />);
            mounted = { root: promotedRoot, host: promotedHost };
            await settle();
            const promotedRow = element('[data-session-id="promoted-task"] button.session-row', "Promoted full-task row");
            promotedRow.click();
            await settle();
            check(openedTaskId === promoted.id, "The promoted side chat was not discoverable as a full task");

            await unmount();
            HTMLTextAreaElement.prototype.focus = nativeTextareaFocus;
            opener.remove();
            outsideTarget.remove();
            window.__sideChatQaResult = { ok: true };
          } catch (error) {
            window.__sideChatQaResult = { ok: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : "" };
          }
        `,
      },
      outfile: rendererBundle,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome136",
      loader: { ".css": "empty" },
      plugins: [inlineWorkerStubPlugin],
    });
    await writeFile(htmlPath, '<!doctype html><html><body><script type="module" src="./renderer.js"></script></body></html>', "utf8");
    await writeFile(mainPath, String.raw`
      const path = require("node:path");
      const { app, BrowserWindow } = require("electron");
      app.commandLine.appendSwitch("disable-gpu");
      app.setPath("userData", path.join(__dirname, "profile"));
      app.whenReady().then(async () => {
        const window = new BrowserWindow({ show: false, x: -10000, y: -10000, width: 1200, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
        await window.loadFile(process.argv[2]);
        const result = await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const started = performance.now(); const check = () => { if (window.__sideChatQaResult) return resolve(window.__sideChatQaResult); if (performance.now() - started > 25000) return reject(new Error("Renderer did not finish mounted side-chat QA")); setTimeout(check, 10); }; check(); })', true);
        process.stdout.write("TETHOQ_SIDE_CHAT_QA=" + JSON.stringify(result) + "\n");
        window.destroy();
        app.quit();
      }).catch((error) => { console.error(error); app.exitCode = 1; app.quit(); });
    `, "utf8");

    const result = await runElectron(mainPath, htmlPath);
    assert.deepEqual(result, { ok: true }, result.error ?? result.stack);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
