/**
 * Pure grounding helpers for instant-session evidence. The implementations
 * live in `src/shared/live_session_prompt.ts` so the renderer composes the
 * identical narrative; this module keeps the recorder-style import names.
 */
export {
  normalizedLivePoint as normalizedPoint,
  livePointerSummary as pointerSummary,
  formatLiveClock as formatClock,
  buildUtterancePrompt,
  buildEyesQuestion,
} from "../../shared/live_session_prompt.js";
