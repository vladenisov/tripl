import { useId, useState } from 'react'
import { Trash2, X } from 'lucide-react'

import type { VariableType } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/settings/kit'
import { getErrorMessage } from '@/lib/utils'
import { VALUE_LIST_HINT, splitValueList } from './variableValueValidation'

export function VariablesBulkBar({
  selectedCount,
  isPending,
  error,
  typeLabels,
  onSetType,
  onSetDescription,
  onAddValues,
  onDelete,
  onClear,
}: {
  selectedCount: number
  isPending: boolean
  /** The last bulk action's failure, shown in the bar (PLAN-26). */
  error: unknown
  typeLabels: Record<VariableType, string>
  /** Confirms, then applies; resolves true once the type has changed. */
  onSetType: (variableType: VariableType) => Promise<boolean>
  onSetDescription: (description: string) => Promise<unknown>
  /** Checks the values against each selected type first; resolves false when
   * the operator backed out, so the draft stays. */
  onAddValues: (values: string[]) => Promise<boolean>
  onDelete: () => void
  onClear: () => void
}) {
  const [typeDraft, setTypeDraft] = useState<VariableType | ''>('')
  const [description, setDescription] = useState('')
  const [valuesDraft, setValuesDraft] = useState('')
  const valuesHintId = useId()
  if (selectedCount === 0) return null

  // Drafts are dropped once the change has LANDED. They used to be cleared on
  // click, so a 403, a stale-id 404 or a 422 threw away what was typed and
  // said nothing (PLAN-26); a failure now leaves the draft for another try and
  // the reason beside it. A rejection is already rendered, so it is swallowed.
  // `false` means the operator cancelled a confirm: nothing changed, so the
  // draft stays too (review 204).
  const clearOnSuccess = (action: Promise<unknown>, clear: () => void) => {
    action.then(result => { if (result !== false) clear() }, () => undefined)
  }

  const applyType = () => {
    if (!typeDraft) return
    clearOnSuccess(onSetType(typeDraft), () => setTypeDraft(''))
  }

  const addValues = () => {
    const values = splitValueList(valuesDraft)
    if (values.length === 0) return
    clearOnSuccess(onAddValues(values), () => setValuesDraft(''))
  }

  const applyDescription = () => {
    const next = description.trim()
    if (!next) return
    clearOnSuccess(onSetDescription(next), () => setDescription(''))
  }

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      // Centred with both insets and a capped width. `left-1/2 -translate-x-1/2`
      // sized the bar to the half of the viewport right of centre, so ~700px of
      // controls wrapped into two or three rows below ~1400px and into a 187px
      // column on a phone (PLAN-27).
      className="fixed inset-x-4 bottom-[18px] z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-col gap-1.5 rounded-[10px] border py-1.5 pl-3.5 pr-2"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
          <span className="mono font-semibold" style={{ color: 'var(--fg)' }}>{selectedCount}</span> selected
        </span>
        {/* Staged, then applied with a confirm. Changing the select used to
            retype the whole selection at once, and arrowing through a closed
            select fires a change per option (PLAN-25). */}
        <div className="flex items-center gap-1">
          <div className="w-32">
            <Select
              aria-label="Bulk set type"
              value={typeDraft}
              disabled={isPending}
              onChange={value => setTypeDraft(value as VariableType | '')}
              options={[
                { value: '', label: 'Set type…' },
                ...(Object.keys(typeLabels) as VariableType[]).map(t => ({ value: t, label: typeLabels[t] })),
              ]}
            />
          </div>
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={isPending || !typeDraft} onClick={applyType}>
            Set type
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Input
            aria-label="Bulk description"
            className="h-7 w-36 text-xs"
            placeholder="Set description…"
            value={description}
            onChange={e => setDescription(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyDescription() } }}
          />
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={isPending || !description.trim()} onClick={applyDescription}>
            Apply
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Input
            aria-label="Bulk add values"
            className="h-7 w-40 text-xs"
            placeholder="Add values (comma-sep)…"
            title={VALUE_LIST_HINT}
            aria-describedby={valuesHintId}
            value={valuesDraft}
            onChange={e => setValuesDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addValues() } }}
          />
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={isPending || !valuesDraft.trim()} onClick={addValues}>
            Add values
          </Button>
          <span id={valuesHintId} className="sr-only">{VALUE_LIST_HINT}</span>
        </div>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={isPending} onClick={onDelete}>
          <Trash2 className="mr-1 h-3 w-3" aria-hidden="true" />Delete
        </Button>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Clear selection" disabled={isPending} onClick={onClear}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      {error != null && (
        <p role="alert" className="text-xs text-destructive">
          The bulk change failed: {getErrorMessage(error)}
        </p>
      )}
    </div>
  )
}
