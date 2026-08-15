import type { RecorderState, WorkflowDescriptor } from "@shared/desktop_api";
import { Button } from "./components";
import { ChevronDownIcon, ExternalLinkIcon, KeyboardIcon, MouseIcon, RecordIcon, ScreenshotIcon, ShieldIcon, TrashIcon, WorkflowIcon } from "./icons";

const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

const bytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export function WorkflowSettings({ recorder, workflows, selectedWorkflowId, onSelectWorkflow, onStart, onSave, onReveal, onDelete }: {
  recorder: RecorderState;
  workflows: readonly WorkflowDescriptor[];
  selectedWorkflowId: string | null;
  onSelectWorkflow: (id: string | null) => void;
  onStart: () => Promise<void>;
  onSave: () => void;
  onReveal: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
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
          {isSelected ? <WorkflowDetail key={workflow.id} id={detailId} workflow={workflow} onClose={() => onSelectWorkflow(null)} onReveal={onReveal} onDelete={onDelete} /> : null}
        </div>;
      })}
    </div> : null}
  </section>;
}

function WorkflowDetail({ id, workflow, onClose, onReveal, onDelete }: { id: string; workflow: WorkflowDescriptor; onClose: () => void; onReveal: (id: string) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const started = new Date(workflow.startedAt);
  const stopped = new Date(workflow.stoppedAt);
  return <article className="workflow-detail" id={id} aria-label={`${workflow.name ?? "Workflow"} details`}>
    <div className="workflow-capture-metrics" role="group" aria-label="Capture summary">
      <span><MouseIcon /><strong>{workflow.summary.clickCount}</strong><small>Clicks</small></span>
      <span><MouseIcon /><strong>{workflow.summary.dragCount}</strong><small>Drags</small></span>
      <span><KeyboardIcon /><strong>{workflow.summary.keyEventCount}</strong><small>Key events</small></span>
      <span><ScreenshotIcon /><strong>{workflow.summary.screenshotCount}</strong><small>Frames</small></span>
    </div>
    <details className="workflow-capture-details">
      <summary>Capture details</summary>
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
