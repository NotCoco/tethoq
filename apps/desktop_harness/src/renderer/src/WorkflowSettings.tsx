import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { RecorderState, WorkflowDescriptor, WorkflowScreenshot, WorkflowScreenshotImage } from "@shared/desktop_api";
import { Button } from "./components";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, KeyboardIcon, MouseIcon, RecordIcon, ScreenshotIcon, ShieldIcon, TrashIcon, WorkflowIcon, XIcon } from "./icons";

const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

const bytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export function WorkflowSettings({ recorder, workflows, selectedWorkflowId, onSelectWorkflow, onStart, onSave, onReveal, onDelete, onListScreenshots, onLoadScreenshot }: {
  recorder: RecorderState;
  workflows: readonly WorkflowDescriptor[];
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string | null) => void;
  onStart: () => Promise<void>;
  onSave: () => void;
  onReveal: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onListScreenshots: (id: string) => Promise<readonly WorkflowScreenshot[]>;
  onLoadScreenshot: (id: string, frameId: string, variant: "thumbnail" | "full") => Promise<WorkflowScreenshotImage>;
}) {
  return <section className="settings-section workflow-settings-section" id="workflow-settings" aria-labelledby="recorded-workflows-heading">
    <header className="workflow-settings-header">
      <h2 id="recorded-workflows-heading">Recorded workflows</h2>
      {recorder.phase === "staged"
        ? <Button className="workflow-action workflow-save-action" variant="primary" onClick={onSave}><RecordIcon /> Name and save</Button>
        : <Button className="workflow-action workflow-record-action" variant="ghost" onClick={() => void onStart()} disabled={!recorder.supported || recorder.phase !== "idle"}><RecordIcon />{recorder.phase === "recording" ? "Recording" : "Record workflow"}</Button>}
    </header>
    {workflows.length ? <div className="workflow-settings-list" aria-label="Recorded workflows">
      {workflows.map((workflow) => {
        const isSelected = workflow.id === selectedWorkflowId;
        const detailId = `workflow-detail-${workflow.id}`;
        return <div className={`workflow-entry ${isSelected ? "selected" : ""}`} key={workflow.id}>
          <button className="workflow-entry-trigger" onClick={() => onSelectWorkflow(isSelected ? null : workflow.id)} aria-expanded={isSelected} aria-controls={detailId}>
            <span className="workflow-list-icon" aria-hidden="true"><WorkflowIcon /></span>
            <span className="workflow-entry-copy"><strong>{workflow.name ?? "Unnamed workflow"}</strong><small>{new Date(workflow.startedAt).toLocaleDateString()} &middot; {duration(workflow.durationMs)} &middot; {workflow.summary.eventCount} events</small></span>
            <span className="workflow-entry-chevron" aria-hidden="true"><ChevronDownIcon /></span>
          </button>
          {isSelected ? <WorkflowDetail key={workflow.id} id={detailId} workflow={workflow} onClose={() => onSelectWorkflow(null)} onReveal={onReveal} onDelete={onDelete} onListScreenshots={onListScreenshots} onLoadScreenshot={onLoadScreenshot} /> : null}
        </div>;
      })}
    </div> : null}
  </section>;
}

function WorkflowDetail({ id, workflow, onClose, onReveal, onDelete, onListScreenshots, onLoadScreenshot }: { id: string; workflow: WorkflowDescriptor; onClose: () => void; onReveal: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onListScreenshots: (id: string) => Promise<readonly WorkflowScreenshot[]>; onLoadScreenshot: (id: string, frameId: string, variant: "thumbnail" | "full") => Promise<WorkflowScreenshotImage> }) {
  const started = new Date(workflow.startedAt);
  const stopped = new Date(workflow.stoppedAt);
  const [captureDetailsOpen, setCaptureDetailsOpen] = useState(false);
  return <article className="workflow-detail" id={id} aria-label={`${workflow.name ?? "Workflow"} details`}>
    <div className="workflow-capture-metrics" role="group" aria-label="Capture summary">
      <span><MouseIcon /><strong>{workflow.summary.clickCount}</strong><small>Clicks</small></span>
      <span><MouseIcon /><strong>{workflow.summary.dragCount}</strong><small>Drags</small></span>
      <span><KeyboardIcon /><strong>{workflow.summary.keyEventCount}</strong><small>Key events</small></span>
      <span><ScreenshotIcon /><strong>{workflow.summary.screenshotCount}</strong><small>Frames</small></span>
    </div>
    <details className="workflow-capture-details" onToggle={(event) => setCaptureDetailsOpen(event.currentTarget.open)}>
      <summary>Capture details</summary>
      {captureDetailsOpen && workflow.summary.screenshotCount > 0 ? <WorkflowScreenshotGallery workflow={workflow} onListScreenshots={onListScreenshots} onLoadScreenshot={onLoadScreenshot} /> : null}
      <dl className="workflow-detail-timing workflow-captured-data">
        <div><dt>Started</dt><dd>{started.toLocaleString()}</dd></div>
        <div><dt>Stopped</dt><dd>{stopped.toLocaleString()}</dd></div>
        <div><dt>Captured apps</dt><dd>{workflow.summary.apps.length ? workflow.summary.apps.join(", ") : "No app names captured"}</dd></div>
        <div><dt>Local storage</dt><dd>{bytes(workflow.summary.bytesWritten)}</dd></div>
        <div><dt>Capture issues</dt><dd>{workflow.summary.droppedFrames} dropped frames &middot; {workflow.summary.contextErrors} context errors</dd></div>
        <div><dt>Stop reason</dt><dd>{workflow.stopReason.replaceAll("-", " ")}</dd></div>
      </dl>
      <p className="workflow-detail-privacy"><ShieldIcon />Screen content and key codes may contain sensitive information. This recording remains local unless you deliberately share it.</p>
    </details>
    <footer>
      <Button className="workflow-action workflow-close-action" variant="ghost" onClick={onClose}>Close details</Button>
      <Button className="workflow-action" variant="ghost" onClick={() => void onReveal(workflow.id)}><ExternalLinkIcon /> Open folder</Button>
      <Button className="workflow-action workflow-delete-action" variant="danger" onClick={() => void onDelete(workflow.id)}><TrashIcon /> Delete</Button>
    </footer>
  </article>;
}

function WorkflowScreenshotGallery({ workflow, onListScreenshots, onLoadScreenshot }: { workflow: WorkflowDescriptor; onListScreenshots: (id: string) => Promise<readonly WorkflowScreenshot[]>; onLoadScreenshot: (id: string, frameId: string, variant: "thumbnail" | "full") => Promise<WorkflowScreenshotImage> }) {
  const [screenshots, setScreenshots] = useState<readonly WorkflowScreenshot[] | null>(null);
  const [selected, setSelected] = useState<{ readonly screenshot: WorkflowScreenshot; readonly preview?: WorkflowScreenshotImage } | null>(null);
  const [fullImage, setFullImage] = useState<WorkflowScreenshotImage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [canSlideBack, setCanSlideBack] = useState(false);
  const [canSlideForward, setCanSlideForward] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;
    setScreenshots(null);
    void onListScreenshots(workflow.id).then((items) => { if (active) setScreenshots(items); }).catch(() => { if (active) setScreenshots([]); });
    return () => { active = false; };
  }, [onListScreenshots, workflow.id]);

  const updateSlideState = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    setCanSlideBack(strip.scrollLeft > 2);
    setCanSlideForward(strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || screenshots === null) return;
    updateSlideState();
    const observer = new ResizeObserver(updateSlideState);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [screenshots, updateSlideState]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    setFullImage(null);
    setLoadFailed(false);
    void onLoadScreenshot(workflow.id, selected.screenshot.frameId, "full").then((image) => { if (active) setFullImage(image); }).catch(() => { if (active) setLoadFailed(true); });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && screenshots?.length) {
        event.preventDefault();
        const current = screenshots.findIndex((item) => item.frameId === selected.screenshot.frameId);
        const offset = event.key === "ArrowLeft" ? -1 : 1;
        const next = screenshots[(current + offset + screenshots.length) % screenshots.length];
        if (next) setSelected({ screenshot: next });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { active = false; window.removeEventListener("keydown", onKeyDown); };
  }, [onLoadScreenshot, screenshots, selected, workflow.id]);

  useEffect(() => {
    if (selected) {
      returnFocus.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const frame = requestAnimationFrame(() => lightboxRef.current?.querySelector<HTMLElement>('button[aria-label="Close screenshot preview"]')?.focus());
      return () => cancelAnimationFrame(frame);
    }
    const target = returnFocus.current;
    returnFocus.current = null;
    if (!target) return;
    const frame = requestAnimationFrame(() => target.isConnected && target.focus());
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  const selectSibling = (offset: -1 | 1) => {
    if (!selected || !screenshots?.length) return;
    const current = screenshots.findIndex((item) => item.frameId === selected.screenshot.frameId);
    const next = screenshots[(current + offset + screenshots.length) % screenshots.length];
    if (next) setSelected({ screenshot: next });
  };

  if (screenshots === null) return <div className="workflow-screenshot-loading" role="status"><span className="spinner" /> Loading screenshots…</div>;
  if (screenshots.length === 0) return <p className="workflow-screenshot-empty">The saved screenshot files are unavailable.</p>;
  return <section className="workflow-screenshot-gallery" aria-label="Workflow screenshots">
    <header>
      <strong>Screenshots</strong>
      <span className="workflow-screenshot-slider-actions">
        {canSlideBack ? <button type="button" aria-label="Previous screenshots" onClick={() => stripRef.current?.scrollBy({ left: -420, behavior: "smooth" })}><ChevronRightIcon /></button> : null}
        {canSlideForward ? <button type="button" aria-label="Next screenshots" onClick={() => stripRef.current?.scrollBy({ left: 420, behavior: "smooth" })}><ChevronRightIcon /></button> : null}
      </span>
    </header>
    <div className="workflow-screenshot-strip" ref={stripRef} role="list" onScroll={updateSlideState}>
      {screenshots.map((screenshot) => <WorkflowScreenshotThumbnail key={screenshot.frameId} workflowId={workflow.id} screenshot={screenshot} stripRef={stripRef} onLoadScreenshot={onLoadScreenshot} onOpen={(preview) => setSelected(preview ? { screenshot, preview } : { screenshot })} />)}
    </div>
    {selected ? <div ref={lightboxRef} className="workflow-screenshot-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${selected.screenshot.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <button className="workflow-screenshot-lightbox-close" type="button" aria-label="Close screenshot preview" onClick={() => setSelected(null)}><XIcon /></button>
      {screenshots.length > 1 ? <button className="workflow-screenshot-lightbox-previous" type="button" aria-label="Previous screenshot" onClick={() => selectSibling(-1)}><ChevronRightIcon /></button> : null}
      <figure>
        {fullImage || selected.preview ? <img src={(fullImage ?? selected.preview)?.dataUrl} alt={selected.screenshot.name} /> : loadFailed ? <p>Screenshot preview unavailable.</p> : <span className="workflow-screenshot-lightbox-loading"><span className="spinner" /> Loading full screenshot…</span>}
        <figcaption>{selected.screenshot.name}</figcaption>
      </figure>
      {screenshots.length > 1 ? <button className="workflow-screenshot-lightbox-next" type="button" aria-label="Next screenshot" onClick={() => selectSibling(1)}><ChevronRightIcon /></button> : null}
    </div> : null}
  </section>;
}

function WorkflowScreenshotThumbnail({ workflowId, screenshot, stripRef, onLoadScreenshot, onOpen }: { workflowId: string; screenshot: WorkflowScreenshot; stripRef: RefObject<HTMLDivElement | null>; onLoadScreenshot: (id: string, frameId: string, variant: "thumbnail" | "full") => Promise<WorkflowScreenshotImage>; onOpen: (preview?: WorkflowScreenshotImage) => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<WorkflowScreenshotImage | null>(null);

  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    let active = true;
    let requested = false;
    const load = () => {
      if (requested) return;
      requested = true;
      void onLoadScreenshot(workflowId, screenshot.frameId, "thumbnail").then((image) => { if (active) setPreview(image); }).catch(() => undefined);
    };
    if (typeof IntersectionObserver === "undefined") load();
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { load(); observer?.disconnect(); }
    }, { root: stripRef.current, rootMargin: "0px 280px" });
    observer?.observe(button);
    return () => { active = false; observer?.disconnect(); };
  }, [onLoadScreenshot, screenshot.frameId, stripRef, workflowId]);

  return <button ref={buttonRef} type="button" className="workflow-screenshot-item" role="listitem" aria-label={`Open ${screenshot.name}`} onClick={() => onOpen(preview ?? undefined)}>
    <span className="workflow-screenshot-media">{preview ? <img src={preview.dataUrl} alt="" loading="lazy" /> : <ScreenshotIcon />}</span>
    <small>{screenshot.name}</small>
  </button>;
}
