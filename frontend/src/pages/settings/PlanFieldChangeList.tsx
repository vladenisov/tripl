import type { PlanFieldChange, PlanValueChange } from '@/types'
import { DiffValue } from './DiffValue'
import { KIND_META } from './branches/branchMeta'

/**
 * Before → after for each field a diff entry changed, with a collection that
 * moved one member at a time shown as those members rather than two dumps of
 * the whole list.
 *
 * The same presentation the branch review gives a changed entry, read-only,
 * so a revision diff says what changed and not only which fields did
 * (PLAN-51). Kinds wear the branch review's own labels and tones.
 */
export function PlanFieldChangeList({ changes }: { changes: PlanFieldChange[] }) {
  return (
    <div className="flex flex-col gap-2">
      {changes.map((change) => (
        <div
          key={change.field}
          className="rounded-md border px-2.5 py-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="mb-1">
            <span className="mono text-[11.5px] font-medium" style={{ color: 'var(--fg)' }}>
              {change.field}
            </span>
          </div>
          {change.items && change.items.length > 0 ? (
            <div className="flex flex-col gap-1">
              {change.items.map((item) => (
                <PlanValueChangeRow key={item.key} item={item} />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-1.5">
              <DiffValue value={change.before} tone="danger" />
              <span className="text-[12px]" style={{ color: 'var(--fg-faint)' }} aria-hidden="true">
                →
              </span>
              <DiffValue value={change.after} tone="success" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** One member of a changed collection: `~ currency  USD → EUR`. */
function PlanValueChangeRow({ item }: { item: PlanValueChange }) {
  const meta = KIND_META[item.kind]
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-[11.5px]">
      <span
        className="mono w-3 shrink-0 text-center font-bold"
        style={{ color: `var(--${meta.tone})` }}
        aria-hidden="true"
      >
        {meta.sym}
      </span>
      <span className="mono shrink-0" style={{ color: 'var(--fg)' }}>
        {item.key}
      </span>
      {item.kind === 'changed' ? (
        <>
          <DiffValue value={item.before} tone="danger" />
          <span className="text-[12px]" style={{ color: 'var(--fg-faint)' }} aria-hidden="true">
            →
          </span>
          <DiffValue value={item.after} tone="success" />
        </>
      ) : (
        <DiffValue value={item.kind === 'added' ? item.after : item.before} tone={meta.tone} />
      )}
    </div>
  )
}
