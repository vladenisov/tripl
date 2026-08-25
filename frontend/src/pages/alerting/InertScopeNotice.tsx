import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

/** The two alert scopes whose candidates come from configuration a rule does not own. */
export type DriftScope = 'distribution_drift' | 'variable_value_drift'

interface ScopeCopy {
  /** Names the missing thing, never the reader's mistake — nothing here is misconfigured. */
  sentence: string
  /**
   * A second line for what the link alone cannot tell the reader. Notice-only:
   * the chip's `title` carries the verdict, not the mechanics behind it.
   */
  note?: string
  linkLabel: string
  /** Path builder, so both callers send the reader to the same screen. */
  href: (slug: string) => string
}

/**
 * One copy table, one component, two callers — the rule editor and the monitor
 * detail. Kept together so the sentence and the destination cannot drift apart
 * between the screen that switches a scope on and the screen that reports it is
 * doing nothing.
 *
 * Two qualifiers in the variable-value wording are load-bearing, because the
 * backend probe carries both and a sentence that drops them is simply false
 * (tripl-wkwv.1):
 *
 * - "on the main branch" — detection runs against main, so documenting values
 *   on a working branch changes nothing until it merges. Without it the notice
 *   reads as flatly false to anyone looking at a branch that does document them.
 * - "that scans observe" — the probe skips variables excluded from scans, so a
 *   project whose only documented variable is excluded gets this notice; without
 *   it the sentence contradicts the very list sitting in the database.
 *
 * The note exists because the link cannot honour the first qualifier: Variables
 * opens on whatever branch the reader has selected, and a help link is the wrong
 * place to reach in and reset a selection the whole app shares.
 */
const SCOPE_COPY: Record<DriftScope, ScopeCopy> = {
  distribution_drift: {
    sentence:
      'Distribution drift is on, but no scan in this project watches a column for it — this scope cannot fire until one does.',
    linkLabel: 'Scan settings',
    href: (slug) => `/p/${slug}/scans`,
  },
  variable_value_drift: {
    sentence:
      'Value drift is on, but no variable that scans observe documents an allowed-values list on the main branch — this scope cannot fire until one does.',
    note: 'Variables opens on the branch you have selected; a list documented on a working branch counts only once it merges.',
    linkLabel: 'Variables',
    href: (slug) => `/p/${slug}/settings/variables`,
  },
}

/**
 * The sentence a caller repeats elsewhere (a chip's `title`, say).
 *
 * Exported from the component's own file on purpose: a chip marked inert and
 * the notice explaining it must say the same thing, and two modules is how that
 * stops being true.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function inertScopeSentence(scope: DriftScope): string {
  return SCOPE_COPY[scope].sentence
}

/**
 * Says that an enabled scope has no source data, and links to the screen that
 * supplies it.
 *
 * No `role="alert"`: this is persistent state the reader can act on whenever
 * they like, not an event that just happened — the same reasoning as the
 * disabled-destination block on the monitor detail. Announcing it would
 * interrupt on every poll.
 *
 * `newTab` is opt-in and set by one caller only. The rule editor renders this
 * inside a modal `<form>` whose draft lives in component state, so a same-tab
 * navigation unmounts the dialog and discards a half-built rule: the one screen
 * reporting the problem would destroy the work the moment the reader acted on
 * the report. The monitor detail is read-only, where same-tab is right
 * (tripl-wkwv.1).
 */
export function InertScopeNotice({
  slug,
  scope,
  newTab = false,
}: {
  slug?: string
  scope: DriftScope
  newTab?: boolean
}) {
  const copy = SCOPE_COPY[scope]
  return (
    <div
      className="flex items-start gap-2 rounded-md px-3 py-2 text-[12px]"
      style={{ background: 'var(--warning-soft)', color: 'var(--fg-muted)' }}
    >
      <AlertTriangle
        aria-hidden="true"
        className="mt-[1px] h-3.5 w-3.5 shrink-0"
        style={{ color: 'var(--warning)' }}
      />
      {/* The sentence keeps its own element so it stays the whole of its node's
          text: the note is a sibling, not more words inside it. */}
      <div className="min-w-0">
        <span>
          {copy.sentence}{' '}
          {slug && (
            <Link
              to={copy.href(slug)}
              // React Router hands any target other than `_self` back to the
              // browser, so this is what keeps the dialog mounted.
              target={newTab ? '_blank' : undefined}
              rel={newTab ? 'noreferrer' : undefined}
              className="no-underline hover:underline"
              style={{ color: 'var(--fg)' }}
            >
              {copy.linkLabel}
            </Link>
          )}
        </span>
        {copy.note && (
          <span className="mt-0.5 block" style={{ color: 'var(--fg-faint)' }}>
            {copy.note}
          </span>
        )}
      </div>
    </div>
  )
}
