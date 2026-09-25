import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'

const DEFAULT_DESCRIPTION = 'The page you’re looking for doesn’t exist or may have moved.'

const ACTION_CLASS =
  'inline-flex items-center rounded-md px-4 py-2 text-sm font-medium no-underline transition-opacity hover:opacity-90'

const PRIMARY_ACTION: CSSProperties = { background: 'var(--accent)', color: 'var(--bg-sunken)' }

const SECONDARY_ACTION: CSSProperties = {
  border: '1px solid var(--border-strong)',
  color: 'var(--fg)',
}

/** The project a missing page sat under, when the URL named one that exists. */
interface NotFoundProject {
  slug: string
  name: string
}

interface NotFoundStateProps {
  /** Headline. Defaults to the generic route-level message. */
  title?: string
  /** One-sentence explanation under the headline. */
  description?: string
  /**
   * Offer the project as well as the portfolio. Only pass a project that is
   * known to exist — this is the way back for a mistyped sub-path, not a guess
   * at the slug in the URL.
   */
  project?: NotFoundProject
}

/**
 * The shared "there is nothing here" panel. Used by the catch-all route
 * (pages/NotFoundPage) and — with project-specific wording — by the app shell when the `:slug` in the
 * URL matches no project the viewer can see.
 */
export function NotFoundState({
  title = 'Page not found',
  description = DEFAULT_DESCRIPTION,
  project,
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
      {/* A project-scoped 404 keeps that project's sidebar and breadcrumb, so
          ejecting to the portfolio was two navigations away from where the
          reader actually was (tripl-tvqk). When we know the project, it leads
          and the portfolio stays as the secondary way out. */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
        {project && (
          <Link
            to={`/p/${project.slug}/events`}
            className={ACTION_CLASS}
            style={PRIMARY_ACTION}
          >
            Back to {project.name}
          </Link>
        )}
        <Link
          to="/workspace"
          className={ACTION_CLASS}
          style={project ? SECONDARY_ACTION : PRIMARY_ACTION}
        >
          {project ? 'All projects' : 'Back to all projects'}
        </Link>
      </div>
    </div>
  )
}
