import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { AlertTriangle, RefreshCw, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { isChunkLoadError } from '@/lib/lazyWithReload'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Optional custom fallback. Receives the caught error and a reset callback. */
  fallback?: (error: unknown, reset: () => void) => ReactNode
  /**
   * Clears a caught error when it changes. A route boundary passes the
   * pathname, so navigating away from a page that threw shows the next page
   * instead of the same error card. Changing it does not remount the children.
   */
  resetKey?: unknown
  /**
   * `page` renders the card inside the content column, so the shell around a
   * route boundary stays usable; `screen` fills the viewport (top level).
   */
  variant?: 'screen' | 'page'
}

interface ErrorBoundaryState {
  error: unknown
}

function reloadPage(): void {
  window.location.reload()
}

/**
 * React error boundary. Catches render-time errors anywhere below it and shows
 * a recoverable fallback instead of unmounting the whole tree.
 *
 * Async/data-fetch errors are handled by the QueryClient caches (which surface
 * toasts); this boundary is the backstop for synchronous render failures.
 *
 * "Try again" re-renders the same tree, which cannot help when a lazy chunk
 * failed to load — React caches the rejected import — so that case offers only
 * "Reload page", which fetches the current build.
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

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error != null && !Object.is(prevProps.resetKey, this.props.resetKey)) {
      this.reset()
    }
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

    const chunkFailed = isChunkLoadError(error)
    const onPage = this.props.variant === 'page'
    const card = (
      <div
        role="alert"
        className="w-full max-w-lg rounded-xl border border-destructive/35 bg-destructive/5 p-5 text-left"
      >
        <div className="flex items-center gap-3">
          <div className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {/* h2 on a page: the page's own h1 is what this replaced, and the
                shell around it keeps its landmarks. */}
            {onPage ? (
              <h2 className="text-base font-semibold text-foreground">
                {chunkFailed ? 'This page needs a reload' : 'This page hit an error'}
              </h2>
            ) : (
              <h1 className="text-base font-semibold text-foreground">
                {chunkFailed ? 'The app needs a reload' : 'Something went wrong'}
              </h1>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              {chunkFailed
                ? 'A newer version of tripl was deployed since this tab opened, and part of the page could not be loaded. Reload to get the current version.'
                : 'Something unexpected stopped this from rendering. Try again, and if it keeps happening, reload the page.'}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {!chunkFailed && (
                <Button type="button" variant="outline" onClick={this.reset}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Try again
                </Button>
              )}
              <Button type="button" variant={chunkFailed ? 'default' : 'ghost'} onClick={reloadPage}>
                <RotateCw className="mr-2 h-4 w-4" />
                Reload page
              </Button>
            </div>
          </div>
        </div>
      </div>
    )

    if (onPage) {
      return <div className="flex justify-center py-10">{card}</div>
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">{card}</div>
    )
  }
}

/**
 * Boundary for one routed page. A page that throws is replaced by an in-column
 * error card while the sidebar, top bar and toasts stay mounted, and moving to
 * another path clears it.
 */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return (
    <ErrorBoundary variant="page" resetKey={pathname}>
      {children}
    </ErrorBoundary>
  )
}
