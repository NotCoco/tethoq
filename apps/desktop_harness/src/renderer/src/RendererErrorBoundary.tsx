import { Component, type ErrorInfo, type ReactNode } from "react";

type RendererFaultSource = "render" | "window" | "promise" | "startup";

interface RendererFault {
  readonly message: string;
  readonly source: RendererFaultSource;
}

interface RendererErrorBoundaryProps {
  readonly children: ReactNode;
}

interface RendererErrorBoundaryState {
  readonly fault: RendererFault | undefined;
  readonly notice: RendererFault | undefined;
}

type RendererFaultListener = (fault: RendererFault) => void;

/**
 * The only two failures that actually leave nothing to look at. A rejected
 * promise or a stray window error leaves the app mounted and working, and
 * replacing all of it with a recovery card for one is how a refused clipboard
 * write came to look like Tethoq dying. Those get told, not enthroned.
 */
const fatalFaultSources: ReadonlySet<RendererFaultSource> = new Set<RendererFaultSource>(["render", "startup"]);

const faultListeners = new Set<RendererFaultListener>();
let latestFault: RendererFault | undefined;
let latestNotice: RendererFault | undefined;
let globalFaultHandlersInstalled = false;

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim() !== "") return value.message;
  if (typeof value === "string" && value.trim() !== "") return value;
  return fallback;
}

function reportRendererFault(source: RendererFaultSource, value: unknown, fallback: string): void {
  const fault = { source, message: errorMessage(value, fallback) } satisfies RendererFault;
  if (fatalFaultSources.has(source)) latestFault = fault; else latestNotice = fault;
  console.error(`[Tethoq renderer:${source}] ${fault.message}`, value);
  for (const listener of faultListeners) listener(fault);
}

export function installGlobalRendererFaultHandlers(): void {
  if (globalFaultHandlersInstalled) return;
  globalFaultHandlersInstalled = true;
  window.addEventListener("error", (event) => {
    reportRendererFault("window", event.error ?? event.message, "The window stopped unexpectedly.");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportRendererFault("promise", event.reason, "A background action stopped unexpectedly.");
  });
}

export function reportRendererStartupFault(error: unknown): void {
  reportRendererFault("startup", error, "Tethoq could not start this view.");
}

/** What the reader needs to know for each fault source; the message below names the specific failure. */
const rendererFaultHeadlines: Record<RendererFaultSource, string> = {
  render: "The view failed to display.",
  window: "The window hit an unexpected error.",
  promise: "A background action stopped unexpectedly.",
  startup: "Tethoq could not start this view.",
};

/**
 * A fault must never leave the window empty: with no fault the children render,
 * and with one the recovery card below always renders visible, actionable text
 * that names the source and the message instead of a blank pane.
 */
export default class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  public override state: RendererErrorBoundaryState = { fault: latestFault, notice: latestNotice };

  readonly #handleReportedFault = (fault: RendererFault): void => {
    if (fatalFaultSources.has(fault.source)) this.setState({ fault });
    else this.setState({ notice: fault });
  };

  public static getDerivedStateFromError(error: unknown): Partial<RendererErrorBoundaryState> {
    return { fault: { source: "render", message: errorMessage(error, "This view stopped unexpectedly.") } };
  }

  public override componentDidMount(): void {
    faultListeners.add(this.#handleReportedFault);
    if (latestFault !== undefined && this.state.fault === undefined) this.setState({ fault: latestFault });
    if (latestNotice !== undefined && this.state.notice === undefined) this.setState({ notice: latestNotice });
  }

  public override componentWillUnmount(): void {
    faultListeners.delete(this.#handleReportedFault);
  }

  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[Tethoq renderer:render] React could not display the current view", error, info.componentStack);
    const failingComponent = info.componentStack?.trim().split(/\n/u)[0]?.trim() ?? "";
    const message = errorMessage(error, "This view stopped unexpectedly.");
    this.setState((current) => current.fault?.source === "render"
      ? { fault: { source: "render", message: failingComponent ? `${message} — ${failingComponent}` : message } }
      : current);
  }

  readonly #retry = (): void => {
    latestFault = undefined;
    this.setState({ fault: undefined });
  };

  readonly #dismissNotice = (): void => {
    latestNotice = undefined;
    this.setState({ notice: undefined });
  };

  readonly #reload = (): void => {
    window.location.reload();
  };

  public override render(): ReactNode {
    const fault = this.state.fault;
    const notice = this.state.notice;
    // Nothing fatal: the app is still there, so it stays on screen. A background
    // failure is reported beside it and can be dismissed, because taking a
    // working window away is a bigger failure than the one being reported.
    if (fault === undefined) return <>
      {this.props.children ?? null}
      {notice === undefined ? null : <aside className="renderer-notice" role="status" aria-live="polite">
        <span aria-hidden="true">!</span>
        <div>
          <strong>{rendererFaultHeadlines[notice.source]}</strong>
          <small>{notice.message}</small>
        </div>
        <button type="button" onClick={this.#dismissNotice}>Dismiss</button>
      </aside>}
    </>;
    return (
      <main className="renderer-fault" role="alert" aria-live="assertive">
        <section>
          <span aria-hidden="true">!</span>
          <h1>Tethoq hit a problem</h1>
          <p>{rendererFaultHeadlines[fault.source]}</p>
          <small>{fault.message}</small>
          <div>
            <button type="button" onClick={this.#retry}>Try again</button>
            <button type="button" className="renderer-fault-primary" onClick={this.#reload}>Reload window</button>
          </div>
        </section>
      </main>
    );
  }
}
