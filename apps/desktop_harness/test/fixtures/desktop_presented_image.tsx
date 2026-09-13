import React from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/src/styles.css";

const native = (window as any).qaImage;
(window as any).tethoqDesktop = { request: native.request };
const waitFor = async (check: () => unknown) => {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Image UI did not settle");
};
const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };

try {
  const { loadSessionTimelinePage } = await import("../../src/renderer/src/bridge");
  const { ChatTimeline } = await import("../../src/renderer/src/ChatTimeline");
  const { reconcileTimelinePage, mergeTimelineImageHydration } = await import("../../src/renderer/src/timeline_merge");
  const { sessionHoldsFollowUpQueue, latestTurnHasCompletedFinal, presentedSessionState, captureSessionWorkingBoundary, sessionBoundaryNeedsVisibleEnding } = await import("../../src/renderer/src/composer_helpers");
  const host = document.createElement("div");
  host.style.cssText = "max-width:850px;margin:32px auto";
  document.body.append(host);
  const root = createRoot(host);
  const render = (timeline: any[], active = false) => root.render(<ChatTimeline timeline={timeline} providerId="opencode" active={active} />);
  const thinking = { id: "active-analysis", kind: "reasoning", title: "Reasoning", body: "Inspecting the current image and continuing the implementation.", state: "running", timestamp: new Date().toISOString() } as const;
  render([thinking], true);
  await waitFor(() => document.querySelector('.reasoning-disclosure[aria-expanded="true"]'));
  (document.querySelector(".reasoning-disclosure") as HTMLButtonElement).click();
  await waitFor(() => document.querySelector('.reasoning-disclosure[aria-expanded="false"] .reasoning-label'));
  const liveLabel = document.querySelector(".reasoning-running .reasoning-label")!;
  const shimmer = liveLabel.getAnimations()[0];
  const assertLiveThinking = (stage: string) => {
    assert(document.querySelector(".reasoning-running .reasoning-label") === liveLabel, `${stage}: image presentation must keep the same live reasoning label`);
    if (shimmer) assert(liveLabel.getAnimations()[0] === shimmer, `${stage}: the existing shimmer animation must not restart`);
    assert(!document.querySelector(".working-pulse"), `${stage}: the live disclosure must not be replaced with another indicator`);
  };
  const sessionId = await native.present();
  const first = await loadSessionTimelinePage(sessionId);
  assert(first.items.filter(item => item.images?.length).length === 1, "One saved image entry");
  assert(first.items.find(item => item.images?.length)?.phase === "final_answer", "An uncaptioned image stays outside collapsed reasoning");
  assert(first.items.find(item => item.images?.length)?.presentationOnly, "Presentation metadata survives the real wire protocol");
  assert(sessionHoldsFollowUpQueue({ state: "working" }, first.items), "Showing an image must not release queued instructions");
  assert(!latestTurnHasCompletedFinal(first.items), "An image is not terminal evidence");
  assert(presentedSessionState({ state: "working" }, first.items) === "working", "Showing an image keeps Stop available");
  assert(sessionBoundaryNeedsVisibleEnding(first.items, captureSessionWorkingBoundary([])), "An image does not end the turn's visible boundary");
  render([thinking, ...first.items], true);
  await waitFor(() => document.querySelector(".message-image-unavailable"));
  assertLiveThinking("Loading the preview");
  const hydrated = await first.imageHydration!;
  render([thinking, ...hydrated], true);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  assertLiveThinking("Displaying the preview");
  (document.querySelector(".reasoning-disclosure") as HTMLButtonElement).click();
  await waitFor(() => document.querySelector(".reasoning-flow-running") && document.querySelector(".working-pulse"));
  const liveFlow = document.querySelector(".reasoning-flow-running");
  const livePulse = document.querySelector(".working-pulse");
  const refreshedWhileWorking = await loadSessionTimelinePage(sessionId, undefined, 40, true);
  render(reconcileTimelinePage(refreshedWhileWorking.items, [thinking, ...hydrated]), true);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  assert(document.querySelector(".reasoning-flow-running") === liveFlow, "Refreshing the image keeps the expanded thought live");
  assert(document.querySelector(".working-pulse") === livePulse, "Refreshing the image does not remount the expanded view's live pulse");
  // OpenCode and other harnesses may omit phases on their actual final reply.
  // A separately displayed image must not make that reply disappear into Reasoning.
  const finalReply = { id: "native-final", messageId: "native-final", kind: "assistant", body: "The rendered image is ready.", timestamp: new Date().toISOString(), state: "completed" } as const;
  render([...hydrated, finalReply]);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await waitFor(() => (document.querySelector(".message-images img") as HTMLImageElement)?.naturalWidth > 0);
  assert(!document.querySelector(".reasoning-running"), "Actual task completion still ends the shimmer");
  assert([...document.querySelectorAll("p")].some(element => element.textContent === finalReply.body && element.getBoundingClientRect().height > 0), "The provider's unphased answer remains visible alongside the image");
  const image = document.querySelector(".message-images img") as HTMLImageElement;
  assert(image.getBoundingClientRect().width > 10, "Image is visibly sized in chat");
  assert(!document.querySelector(".message-image-unavailable"), "Loading placeholder clears");
  (document.querySelector(".message-images button") as HTMLButtonElement).click();
  await waitFor(() => document.querySelector(".image-lightbox img"));
  assert((document.querySelector(".image-lightbox img") as HTMLImageElement).src === image.src, "Full preview shows the same image");
  const expandedImage = document.querySelector(".image-lightbox img");
  let current = [...hydrated, finalReply];
  for (let refresh = 0; refresh < 6; refresh++) {
    const page = await loadSessionTimelinePage(sessionId, undefined, 40, true);
    current = reconcileTimelinePage([...page.items, finalReply], current);
    render(current);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    assert(document.querySelector(".message-images img") === image && image.isConnected, "Periodic history refresh remounted the image preview");
    assert(document.querySelector(".image-lightbox img") === expandedImage, "Periodic history refresh reset the open image preview");
    assert(!document.querySelector(".message-image-unavailable"), "Periodic refresh flashed a loading placeholder");
    if (page.imageHydration) { current = mergeTimelineImageHydration(current, await page.imageHydration); render(current); }
  }
  (document.querySelector('[aria-label="Close image preview"]') as HTMLButtonElement).click();
  await waitFor(() => !document.querySelector(".image-lightbox"));
  await native.restart();
  const reopened = await loadSessionTimelinePage(sessionId, undefined, 40, true);
  render(reopened.imageHydration ? await reopened.imageHydration : reopened.items);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await waitFor(() => (document.querySelector(".message-images img") as HTMLImageElement)?.naturalWidth > 0);
  assert(document.querySelectorAll(".message-images img").length === 1, "Retry and restart leave exactly one image");
  await native.capture();
  (window as any).__imageResult = { ok: true, width: image.naturalWidth, restored: true };
} catch (error) {
  (window as any).__imageResult = { ok: false, error: String((error as Error).stack ?? error) };
}
