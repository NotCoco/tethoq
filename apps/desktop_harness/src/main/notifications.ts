import { Notification, type BrowserWindow } from "electron";
import type { AgentEvent } from "../../../../packages/protocol/src/index.js";
import type { DesktopAlertLevel } from "../shared/desktop_api.js";

const ATTENTION_EVENTS = new Set<AgentEvent["type"]>([
  "approval.requested",
  "user_input.requested",
  "agent.error",
]);

const ROUTINE_EVENTS = new Set<AgentEvent["type"]>([
  "agent.completed",
]);

/**
 * `attention` keeps every event that stops the work — a decision, a question, a
 * failure — and drops the ones that only report success.
 */
export function isNotifiableEvent(type: AgentEvent["type"], alerts: DesktopAlertLevel): boolean {
  if (alerts === "off") return false;
  if (ATTENTION_EVENTS.has(type)) return true;
  return alerts === "all" && ROUTINE_EVENTS.has(type);
}

export function notifyForEvents(window: BrowserWindow, events: readonly AgentEvent[], alerts: DesktopAlertLevel): void {
  if (alerts === "off" || window.isFocused() || !Notification.isSupported()) return;
  for (const event of events) {
    if (!isNotifiableEvent(event.type, alerts)) continue;
    const notification = notificationForEvent(event);
    notification.on("click", () => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  }
}

export function notificationForEvent(event: AgentEvent): Notification {
  const session = typeof event.payload.title === "string" ? event.payload.title : "Coding session";
  switch (event.type) {
    case "approval.requested":
      return new Notification({ title: "Approval needed", body: `${session} is waiting for your decision.`, urgency: "critical" });
    case "user_input.requested":
      return new Notification({ title: "Input needed", body: `${session} is waiting for an answer.`, urgency: "critical" });
    case "agent.error":
      return new Notification({ title: "Harness stopped", body: typeof event.payload.message === "string" ? event.payload.message : `${session} encountered an error.` });
    default:
      return new Notification({ title: "Task complete", body: `${session} has finished.` });
  }
}
