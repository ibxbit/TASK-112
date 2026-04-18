import React from "react";
import { WOGCError, ensureWOGCError } from "../utils/errors";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: WOGCError | null;
};

export class GlobalErrorBoundary extends React.Component<Props, State> {
  public constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  public static getDerivedStateFromError(error: unknown): State {
    return { error: ensureWOGCError(error) };
  }

  public componentDidCatch(error: unknown): void {
    this.setState({ error: ensureWOGCError(error) });
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  public render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    const { error } = this.state;
    return (
      <main style={{ padding: "2rem", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        <h1>System Fault</h1>
        <p>
          <strong>{error.code}</strong>: {error.message}
        </p>
        {!error.retryable ? (
          <p>System Halt: this failure is terminal and cannot be retried safely.</p>
        ) : (
          <button type="button" onClick={this.handleRetry}>
            Retry
          </button>
        )}
      </main>
    );
  }
}
