import { useState } from 'react'
import { Trash2, X } from 'lucide-react'

import type { VariableType } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function VariablesBulkBar({
  selectedCount,
  isPending,
  typeLabels,
  onSetType,
  onSetDescription,
  onAddValues,
  onDelete,
  onClear,
}: {
  selectedCount: number
  isPending: boolean
  typeLabels: Record<VariableType, string>
  onSetType: (variableType: VariableType) => void
  onSetDescription: (description: string) => void
  onAddValues: (values: string[]) => void
  onDelete: () => void
  onClear: () => void
}) {
  const [description, setDescription] = useState('')
  const [valuesDraft, setValuesDraft] = useState('')
  if (selectedCount === 0) return null

  const addValues = () => {
    const values = valuesDraft.split(',').map(value => value.trim()).filter(Boolean)
    if (values.length === 0) return
    onAddValues(values)
    setValuesDraft('')
  }

  return (
    <div
      className="fixed bottom-[18px] left-1/2 z-30 flex -translate-x-1/2 flex-wrap items-center gap-2.5 rounded-[10px] border py-1.5 pl-3.5 pr-2"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
        <span className="mono font-semibold" style={{ color: 'var(--fg)' }}>{selectedCount}</span> selected
      </span>
      <select
        aria-label="Bulk set type"
        defaultValue=""
        disabled={isPending}
        onChange={e => {
          if (e.target.value) onSetType(e.target.value as VariableType)
          e.target.value = ''
        }}
        className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
      >
        <option value="">Set type…</option>
        {(Object.keys(typeLabels) as VariableType[]).map(t => (
          <option key={t} value={t}>{typeLabels[t]}</option>
        ))}
      </select>
      <div className="flex items-center gap-1">
        <Input
          aria-label="Bulk description"
          className="h-7 w-36 text-xs"
          placeholder="Set description…"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
        <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={isPending || !description.trim()} onClick={() => { onSetDescription(description.trim()); setDescription('') }}>
          Apply
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Input
          aria-label="Bulk add values"
          className="h-7 w-40 text-xs"
          placeholder="Add values (comma-sep)…"
          value={valuesDraft}
          onChange={e => setValuesDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addValues() } }}
        />
        <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={isPending || !valuesDraft.trim()} onClick={addValues}>
          Add values
        </Button>
      </div>
      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={isPending} onClick={onDelete}>
        <Trash2 className="mr-1 h-3 w-3" aria-hidden="true" />Delete
      </Button>
      <Button type="button" size="icon" variant="ghost" className="h-7 w-7" aria-label="Clear selection" disabled={isPending} onClick={onClear}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  )
}
