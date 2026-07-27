import { Link } from 'react-router-dom'

const DEFAULT_DESCRIPTION = 'The page you’re looking for doesn’t exist or may have moved.'

interface NotFoundStateProps {
  /** Headline. Defaults to the generic route-level message. */
  title?: string
  /** One-sentence explanation under the headline. */
  description?: string
}

/**
 * The shared "there is nothing here" panel. Used by the catch-all route below
 * and — with project-specific wording — by the app shell when the `:slug` in the
 * URL matches no project the viewer can see.
 */
export function NotFoundState({
  title = 'Page not found',
  description = DEFAULT_DESCRIPTION,
}: NotFoundStateProps) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold tracking-wide" style={{ color: 'var(--fg-subtle)' }}>
        404
      </p>
      <h1 className="mt-2 text-2xl font-semibold" style={{ color: 'var(--fg)' }}>
        {title}
      </h1>
      <p className="mt-2 max-w-sm text-sm" style={{ color: 'var(--fg-muted)' }}>
        {description}
      </p>
      <Link
        to="/workspace"
        className="mt-6 inline-flex items-center rounded-md px-4 py-2 text-sm font-medium no-underline transition-opacity hover:opacity-90"
        style={{ background: 'var(--accent)', color: 'var(--bg-sunken)' }}
      >
        Back to all projects
      </Link>
    </div>
  )
}

/**
 * Catch-all not-found state. Rendered inside the app Layout for any unmatched
 * authed path, so the user keeps the sidebar/shell and gets a clear way back to
 * the all-projects portfolio instead of a blank screen. `/p/:slug/*` has its own
 * catch-all route (App.tsx) so an unmatched path under a real project keeps that
 * project's shell rather than collapsing to the workspace one.
 */
export default function NotFoundPage() {
  return <NotFoundState />
}
