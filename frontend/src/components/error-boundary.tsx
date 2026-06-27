import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional custom fallback. Receives the caught error and a reset callback. */
  fallback?: (error: unknown, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: unknown
}

/**
 * Top-level React error boundary. Catches render-time errors anywhere below it
 * and shows a recoverable fallback instead of unmounting the whole tree.
 *
 * Async/data-fetch errors are handled by the QueryClient caches (which surface
 * toasts); this boundary is the backstop for synchronous render failures.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Surface the failure for diagnostics; replace with a real reporter if added.
    console.error('Unhandled render error', error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error == null) {
      return this.props.children
    }

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset)
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div
          role="alert"
          className="w-full max-w-lg rounded-xl border border-destructive/35 bg-destructive/5 p-5 text-left"
        >
          <div className="flex items-center gap-3">
            <div className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-base font-semibold text-foreground">Something went wrong</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                The app hit an unexpected error and could not finish rendering.
                Try again, and if it keeps happening, reload the page.
              </p>
              <Button type="button" variant="outline" className="mt-3" onClick={this.reset}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Try again
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
