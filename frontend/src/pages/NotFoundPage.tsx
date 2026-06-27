import { Link } from 'react-router-dom'

/**
 * Catch-all not-found state. Rendered inside the app Layout for any unmatched
 * authed path, so the user keeps the sidebar/shell and gets a clear way back to
 * the all-projects portfolio instead of a blank screen.
 */
export default function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold tracking-wide" style={{ color: 'var(--fg-subtle)' }}>
        404
      </p>
      <h1 className="mt-2 text-2xl font-semibold" style={{ color: 'var(--fg)' }}>
        Page not found
      </h1>
      <p className="mt-2 max-w-sm text-sm" style={{ color: 'var(--fg-muted)' }}>
        The page you’re looking for doesn’t exist or may have moved.
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
