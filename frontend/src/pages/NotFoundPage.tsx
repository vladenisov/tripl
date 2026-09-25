import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { NotFoundState } from '@/components/not-found-state'
import { useSuppressActivityRail } from '@/components/shell-chrome-context'
import { projectsQueryOptions } from '@/lib/queryKeys'

/**
 * Catch-all not-found state. Rendered inside the app Layout for any unmatched
 * authed path, so the user keeps the sidebar/shell and gets a clear way back to
 * the all-projects portfolio instead of a blank screen. `/p/:slug/*` has its own
 * catch-all route (App.tsx) so an unmatched path under a real project keeps that
 * project's shell rather than collapsing to the workspace one.
 */
export default function NotFoundPage() {
  const { slug } = useParams()
  useSuppressActivityRail()
  // `enabled: false` on the key the shell already owns: read whatever Layout
  // fetched, never ask again. Layout holds every child until `['projects']`
  // settles, so under a project route the answer is already here — and where it
  // is not (OverviewPage renders this page directly when the project endpoint
  // 404s), an absent entry is exactly the right answer: we only offer a project
  // the list confirms, never the raw slug from the URL.
  const projectsQuery = useQuery({ ...projectsQueryOptions(), enabled: false })
  const project = slug ? projectsQuery.data?.find((p) => p.slug === slug) : undefined

  return (
    <NotFoundState project={project ? { slug: project.slug, name: project.name } : undefined} />
  )
}
