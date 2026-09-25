import { Fragment, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'

/**
 * Remount `children` whenever one of the named route params changes.
 *
 * React Router reuses a route's element when only its params change, so a page
 * reached from itself — the "Replaced by" successor link, a bell entry, Back
 * between two details — keeps the previous entity's local state (filters, open
 * tab, drafts) and any `placeholderData` its queries hold, all under the new
 * header. Keying on the params that name the entity makes each entity a fresh
 * mount, which is what the page was written to assume.
 */
export function KeyedRoute({ params, children }: { params: string[]; children: ReactNode }) {
  const values = useParams()
  const key = params.map(name => values[name] ?? '').join('\u0000')
  return <Fragment key={key}>{children}</Fragment>
}
