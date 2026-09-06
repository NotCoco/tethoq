import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const viewportInset = 8;
const tooltipGap = 8;
const initialPointerDelayMs = 450;
const relatedPointerDelayMs = 150;
const hideDelayMs = 100;
const interactiveSelector = "button,a,input,textarea,select,[role='button'],[role='option'],[role='menuitem'],[tabindex]:not([tabindex='-1'])";

interface ActiveTooltip {
  target: HTMLElement;
  text: string;
}

interface TooltipPlacement {
  left: number;
  top: number;
  side: "above" | "below" | "left" | "right";
}

function tooltipTrigger(value: EventTarget | null): HTMLElement | null {
  if (!(value instanceof Element)) return null;
  const target = value.closest<HTMLElement>("[data-tooltip]");
  return target?.dataset.tooltip?.trim() ? target : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function candidateCollides(candidate: TooltipPlacement, width: number, height: number, target: HTMLElement, tooltip: HTMLElement): boolean {
  const anchor = target.getBoundingClientRect();
  if (candidate.left < anchor.right && candidate.left + width > anchor.left
    && candidate.top < anchor.bottom && candidate.top + height > anchor.top) return true;
  const points: Array<readonly [number, number]> = [
    [candidate.left + width / 2, candidate.top + height / 2],
    [candidate.left + 3, candidate.top + 3],
    [candidate.left + width - 3, candidate.top + 3],
    [candidate.left + 3, candidate.top + height - 3],
    [candidate.left + width - 3, candidate.top + height - 3],
  ];
  return points.some(([x, y]) => document.elementsFromPoint(x, y).some((element) => {
    if (element === tooltip || tooltip.contains(element) || element === target || target.contains(element)) return false;
    const interactive = element.closest<HTMLElement>(interactiveSelector);
    return Boolean(interactive && interactive !== target && !target.contains(interactive) && !interactive.contains(target));
  }));
}

function placeTooltip(target: HTMLElement, tooltip: HTMLElement): TooltipPlacement {
  const anchor = target.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const maximumLeft = Math.max(viewportInset, window.innerWidth - width - viewportInset);
  const maximumTop = Math.max(viewportInset, window.innerHeight - height - viewportInset);
  const centredLeft = clamp(anchor.left + (anchor.width - width) / 2, viewportInset, maximumLeft);
  const endLeft = clamp(anchor.right - width, viewportInset, maximumLeft);
  const startLeft = clamp(anchor.left, viewportInset, maximumLeft);
  const preferredLeft = target.dataset.tooltipAlign === "end" ? endLeft : centredLeft;
  const belowTop = anchor.bottom + tooltipGap;
  const aboveTop = anchor.top - tooltipGap - height;
  const verticalOrder = belowTop + height <= window.innerHeight - viewportInset
    ? (["below", "above"] as const)
    : (["above", "below"] as const);
  const horizontalOrder = [...new Set([preferredLeft, centredLeft, endLeft, startLeft])];
  const candidates: TooltipPlacement[] = [];
  for (const side of verticalOrder) {
    const top = clamp(side === "below" ? belowTop : aboveTop, viewportInset, maximumTop);
    for (const left of horizontalOrder) candidates.push({ left, top, side });
  }
  if (anchor.left - tooltipGap - width >= viewportInset) {
    candidates.push({ left: anchor.left - tooltipGap - width, top: clamp(anchor.top + (anchor.height - height) / 2, viewportInset, maximumTop), side: "left" });
  }
  if (anchor.right + tooltipGap + width <= window.innerWidth - viewportInset) {
    candidates.push({ left: anchor.right + tooltipGap, top: clamp(anchor.top + (anchor.height - height) / 2, viewportInset, maximumTop), side: "right" });
  }
  return candidates.find((candidate) => !candidateCollides(candidate, width, height, target, tooltip)) ?? candidates[0] ?? { left: viewportInset, top: viewportInset, side: "below" };
}

export function AppTooltipLayer() {
  const tooltipId = useId();
  const tooltip = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const lastShownAt = useRef(0);
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const [layoutRevision, setLayoutRevision] = useState(0);

  useEffect(() => {
    const clearTimer = (timer: typeof showTimer) => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    const hide = (delayed: boolean) => {
      clearTimer(showTimer);
      clearTimer(hideTimer);
      const commit = () => { setActive(null); setPlacement(null); };
      if (delayed) hideTimer.current = window.setTimeout(commit, hideDelayMs);
      else commit();
    };
    const show = (target: HTMLElement, immediate: boolean) => {
      clearTimer(showTimer);
      clearTimer(hideTimer);
      const commit = () => {
        const text = target.dataset.tooltip?.trim();
        if (!text || !target.isConnected) return;
        lastShownAt.current = Date.now();
        setPlacement(null);
        setActive({ target, text });
      };
      if (immediate) commit();
      else {
        const recentlyVisible = Date.now() - lastShownAt.current < 800;
        showTimer.current = window.setTimeout(commit, recentlyVisible ? relatedPointerDelayMs : initialPointerDelayMs);
      }
    };
    const onPointerOver = (event: PointerEvent) => {
      const target = tooltipTrigger(event.target);
      if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
      show(target, false);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = tooltipTrigger(event.target);
      if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
      hide(true);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTrigger(event.target);
      if (target) show(target, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = tooltipTrigger(event.target);
      if (!target || (event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) return;
      hide(true);
    };
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    return () => {
      clearTimer(showTimer);
      clearTimer(hideTimer);
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const previousDescription = active.target.getAttribute("aria-describedby");
    const descriptions = new Set((previousDescription ?? "").split(/\s+/).filter(Boolean));
    descriptions.add(tooltipId);
    active.target.setAttribute("aria-describedby", [...descriptions].join(" "));
    return () => {
      if (!active.target.isConnected) return;
      if (previousDescription === null) active.target.removeAttribute("aria-describedby");
      else active.target.setAttribute("aria-describedby", previousDescription);
    };
  }, [active, tooltipId]);

  useEffect(() => {
    if (!active) return;
    const target = active.target;
    const observer = new MutationObserver(() => {
      const text = target.dataset.tooltip?.trim();
      if (!text) { setActive(null); return; }
      setActive((current) => current?.target === target && current.text !== text ? { target, text } : current);
    });
    observer.observe(target, { attributes: true, attributeFilter: ["data-tooltip"] });
    return () => observer.disconnect();
  }, [active?.target]);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setLayoutRevision((value) => value + 1));
    };
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [active]);

  useLayoutEffect(() => {
    if (!active || !tooltip.current) return;
    if (!active.target.isConnected) { setActive(null); return; }
    const nextText = active.target.dataset.tooltip?.trim();
    if (!nextText) { setActive(null); return; }
    if (nextText !== active.text) { setActive({ target: active.target, text: nextText }); return; }
    setPlacement(placeTooltip(active.target, tooltip.current));
  }, [active, layoutRevision]);

  if (!active || typeof document === "undefined") return null;
  const style: CSSProperties = placement
    ? { left: placement.left, top: placement.top }
    : { left: 0, top: 0, visibility: "hidden" };
  return createPortal(
    <span ref={tooltip} id={tooltipId} className="app-tooltip-overlay" role="tooltip" data-placement={placement?.side} style={style}>{active.text}</span>,
    document.body,
  );
}
