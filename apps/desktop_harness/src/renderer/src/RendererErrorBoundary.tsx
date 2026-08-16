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
}

type RendererFaultListener = (fault: RendererFault) => void;

const faultListeners = new Set<RendererFaultListener>();
let latestFault: RendererFault | undefined;
let globalFaultHandlersInstalled = false;

function errorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim() !== "") return value.message;
  if (typeof value === "string" && value.trim() !== "") return value;
  return fallback;
}

function reportRendererFault(source: RendererFaultSource, value: unknown, fallback: string): void {
  const fault = { source, message: errorMessage(value, fallback) } satisfies RendererFault;
  latestFault = fault;
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

export default class RendererErrorBoundary extends Component<RendererErrorBoundaryProps, RendererErrorBoundaryState> {
  public override state: RendererErrorBoundaryState = { fault: latestFault };

  readonly #handleReportedFault = (fault: RendererFault): void => {
    this.setState({ fault });
  };

  public static getDerivedStateFromError(error: unknown): RendererErrorBoundaryState {
    return { fault: { source: "render", message: errorMessage(error, "This view stopped unexpectedly.") } };
  }

  public override componentDidMount(): void {
    faultListeners.add(this.#handleReportedFault);
    if (latestFault !== undefined && this.state.fault === undefined) this.setState({ fault: latestFault });
  }

  public override componentWillUnmount(): void {
    faultListeners.delete(this.#handleReportedFault);
  }

  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[Tethoq renderer:render] React could not display the current view", error, info.componentStack);
  }

  readonly #retry = (): void => {
    latestFault = undefined;
    this.setState({ fault: undefined });
  };

  readonly #reload = (): void => {
    window.location.reload();
  };

  public override render(): ReactNode {
    const fault = this.state.fault;
    if (fault === undefined) return this.props.children;
    return (
      <main className="renderer-fault" role="alert" aria-live="assertive">
        <section>
          <span aria-hidden="true">!</span>
          <h1>Tethoq hit a problem</h1>
          <p>The current view stopped unexpectedly.</p>
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
