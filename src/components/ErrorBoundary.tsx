import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { detailsText, toReport, type FrontendErrorReport } from "../diagnostics";
import { reportError } from "../reportError";

interface Props {
  children: ReactNode;
  /** Where this boundary sits, written to the log (`settings:mobile`, `board`, ...). */
  name?: string;
  /** `app` = the whole window (reload the page); `panel` = one region (remount it). */
  variant?: "app" | "panel";
  /** Panels that are dialogs/overlays: offer a Close next to Reload panel. */
  onClose?: () => void;
  /** The panel is a floating dialog/palette: show the fallback in a dialog too. */
  overlay?: boolean;
}

interface State {
  report: FrontendErrorReport | null;
  /** Bumped by "Reload panel" so the children remount from scratch. */
  generation: number;
  copied: boolean;
}

/**
 * Catches render-time errors so one bad component can't blank the whole app, and logs them
 * locally (`log_frontend_error`).
 *
 * KEEP-ALIVE RULE: a panel boundary must never wrap a terminal (`.term-stack` in
 * WorkspaceCenter, the companion shell in RightColumn). "Reload panel" remounts its
 * children, and remounting an xterm kills the PTY under it. Place boundaries around
 * overlays and panes that are siblings of the terminal stack, never above it. The `app`
 * boundary at the root is the exception: by the time it trips, React has already
 * unmounted the whole tree.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { report: null, generation: 0, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { report: toReport("render", error, "pending"), copied: false };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const source = this.props.name ?? (this.props.variant === "app" ? "app" : "panel");
    console.error(`Conduit UI error in ${source}:`, error);
    reportError("render", error, source, info.componentStack);
    this.setState({ report: toReport("render", error, source, info.componentStack) });
  }

  private reload = () => {
    if (this.props.variant === "app") {
      location.reload();
      return;
    }
    this.setState((s) => ({ report: null, generation: s.generation + 1, copied: false }));
  };

  private copy = () => {
    const r = this.state.report;
    if (!r) return;
    void navigator.clipboard
      .writeText(detailsText(r))
      .then(() => this.setState({ copied: true }))
      .catch(() => {});
  };

  render() {
    const { report, generation, copied } = this.state;
    if (!report) {
      return <Fragment key={generation}>{this.props.children}</Fragment>;
    }
    const app = this.props.variant === "app";
    const body = (
      <div className={app ? "crash-screen" : "panel-crash"} role="alert">
        <h2>{app ? "Something went wrong" : "Something went wrong in this panel"}</h2>
        <p className="panel-crash-msg">{report.message}</p>
        <div className="panel-crash-actions">
          <button onClick={this.reload}>{app ? "Reload" : "Reload panel"}</button>
          <button onClick={this.copy}>{copied ? "Copied" : "Copy details"}</button>
          {this.props.onClose && <button onClick={this.props.onClose}>Close</button>}
        </div>
        {report.stack && (
          <details>
            <summary>Details</summary>
            <pre>{report.stack}</pre>
          </details>
        )}
        <p className="panel-crash-note">The error was written to Conduit's local log.</p>
      </div>
    );
    if (!this.props.overlay || app) return body;
    return (
      <div className="dialog-overlay" onClick={this.props.onClose}>
        <div className="dialog panel-crash-dialog" onClick={(e) => e.stopPropagation()}>
          {body}
        </div>
      </div>
    );
  }
}
