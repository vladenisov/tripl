import { memo } from 'react'
import { Ban, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TableCell, TableRow } from '@/components/ui/table'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import type { Variable } from '@/types'

// Chips past this count collapse into a "+N" counter — a variable with dozens
// of documented or observed values must not dominate the table's node budget.
const MAX_CHIPS = 6
// Up to this many event names render as a plain list; above it they collapse
// into a <details> disclosure so the row stays one line tall.
const MAX_INLINE_EVENTS = 3

export interface VariablesTableRowProps {
  variable: Variable
  typeLabel: string
  selected: boolean
  focused: boolean
  rowRef?: React.Ref<HTMLTableRowElement>
  onToggleSelect: (id: string) => void
  onEdit: (variable: Variable) => void
  onExclude: (variable: Variable) => void
  onDelete: (variable: Variable) => void
}

function VariablesTableRowImpl({
  variable,
  typeLabel,
  selected,
  focused,
  rowRef,
  onToggleSelect,
  onEdit,
  onExclude,
  onDelete,
}: VariablesTableRowProps) {
  // Everything the row shows ships with the list response — event names and
  // observed values included — so a row costs zero extra requests.
  const eventNames = variable.event_names ?? []
  const eventCount = variable.event_count ?? eventNames.length
  const hiddenEvents = Math.max(0, eventCount - eventNames.length)
  const observedValues = variable.sample_values ?? []
  const documentedValues = variable.allowed_values ?? []
  const bindings = variable.bindings ?? []
  const driftCount = variable.open_drift_count ?? 0

  return (
    <TableRow
      ref={rowRef}
      data-focused={focused || undefined}
      className={focused ? 'bg-primary/5 outline outline-1 outline-primary/40' : undefined}
    >
      <TableCell className="align-top">
        <input
          type="checkbox"
          aria-label={`Select variable ${variable.name}`}
          checked={selected}
          onChange={() => onToggleSelect(variable.id)}
        />
      </TableCell>
      <TableCell className="font-mono text-xs align-top">
        {/* Pills never wrap and never shrink; the variable name absorbs the
            squeeze instead. In a ~225px column the drift badge broke inside its
            own pill — "1" on one line, "drift" on the next — which reads as a
            rendering fault on the one signal this page asks a reader to act on
            (tripl-bb8m). `whitespace-nowrap` is the house pattern here; the same
            badge in ScansTab already carries it. */}
        <div className="flex min-w-0 items-center gap-2">
          <code className="min-w-0 truncate rounded bg-primary/10 px-1.5 py-0.5 text-primary" title={`\${${variable.name}}`}>
            {`\${${variable.name}}`}
          </code>
          <span className="shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {typeLabel}
          </span>
          {driftCount > 0 && (
            <span className="shrink-0 whitespace-nowrap rounded border border-warning/40 bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning" title="Observed values outside the documented list">
              {driftCount} drift{driftCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {bindings.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {bindings.map(binding => (
              <div key={binding} className="max-w-52 truncate text-[10px] text-muted-foreground" title={binding}>
                ↳ {binding}
              </div>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs align-top">
        {eventCount === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : eventNames.length <= MAX_INLINE_EVENTS ? (
          <ul className="space-y-0.5">
            {eventNames.map(eventName => (
              <li key={eventName}>{eventName}</li>
            ))}
          </ul>
        ) : (
          <details>
            <summary className="cursor-pointer text-muted-foreground">{eventCount} events</summary>
            <ul className="mt-1 space-y-0.5">
              {eventNames.map(eventName => (
                <li key={eventName}>{eventName}</li>
              ))}
              {hiddenEvents > 0 && (
                <li className="text-muted-foreground">+{hiddenEvents} more</li>
              )}
            </ul>
          </details>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground align-top">{variable.description}</TableCell>
      <TableCell className="align-top">
        {documentedValues.length > 0 ? (
          <div className="flex max-w-sm flex-wrap gap-1">
            {documentedValues.slice(0, MAX_CHIPS).map(value => (
              <span key={value} className="max-w-28 truncate rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
            ))}
            {documentedValues.length > MAX_CHIPS && (
              <span className="text-[10px] text-muted-foreground">+{documentedValues.length - MAX_CHIPS}</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {observedValues.length > 0 ? (
          <div className="flex max-w-sm flex-wrap gap-1">
            {observedValues.slice(0, MAX_CHIPS).map(value => (
              <span key={value} className="max-w-28 truncate rounded border px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
            ))}
            {observedValues.length > MAX_CHIPS && (
              <span className="text-[10px] text-muted-foreground">+{observedValues.length - MAX_CHIPS}</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex gap-1 justify-end">
          {/* Exactly one row carries the inspect mark: the seeded drifting
              variable, so the coaching reads as an example. */}
          <ScenarioCoachMark
            step="variables/inspect-values"
            when={variable.name === SCENARIO_SEEDED.driftVariableName}
          >
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit variable ${variable.name}`} onClick={() => onEdit(variable)}>
              <Pencil className="h-3 w-3" aria-hidden="true" />
            </Button>
          </ScenarioCoachMark>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-warning" aria-label={`Exclude variable ${variable.name} from scans`} onClick={() => onExclude(variable)}>
            <Ban className="h-3 w-3" aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Delete variable ${variable.name}`} onClick={() => onDelete(variable)}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}

/** Memoized on purpose: the table renders a page of these and ticking ONE
 * checkbox must not re-render the rest (tripl-jfm3.49 measured ~300 ms–3 s per
 * click when every row re-rendered). Props are the variable object straight off
 * the query cache plus primitives and callbacks the parent keeps stable, so
 * reference equality holds between renders. */
export const VariablesTableRow = memo(VariablesTableRowImpl)
