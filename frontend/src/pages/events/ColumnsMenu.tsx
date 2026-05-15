import { Check, LayoutGrid } from 'lucide-react'
import type { FieldDefinition, MetaFieldDefinition } from '@/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LAST_SEEN_COL_KEY, ROW_METRICS_LABEL } from './utils'

export function ColumnsMenu({
  open,
  onOpenChange,
  tagsHidden,
  lastSeenHidden,
  fieldColumns,
  metaFields,
  hiddenColumns,
  onToggle,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  tagsHidden: boolean
  lastSeenHidden: boolean
  fieldColumns: FieldDefinition[]
  metaFields: MetaFieldDefinition[]
  hiddenColumns: Set<string>
  onToggle: (key: string) => void
}) {
  const totalHidden =
    (tagsHidden ? 1 : 0) +
    (lastSeenHidden ? 1 : 0) +
    fieldColumns.filter((f) => hiddenColumns.has(`f:${f.id}`)).length +
    metaFields.filter((mf) => hiddenColumns.has(`m:${mf.id}`)).length
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs">
          <LayoutGrid className="h-3 w-3" />
          Columns
          {totalHidden > 0 && (
            <span
              className="mono ml-1 tnum text-[10.5px]"
              style={{ color: 'var(--fg-subtle)' }}
            >
              −{totalHidden}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1.5">
        <div
          className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          Toggle columns
        </div>
        <ColumnToggle
          label="Tags"
          pinned={false}
          checked={!tagsHidden}
          onChange={() => onToggle('tags')}
        />
        <ColumnToggle
          label="Last seen"
          pinned={false}
          checked={!lastSeenHidden}
          onChange={() => onToggle(LAST_SEEN_COL_KEY)}
        />
        {fieldColumns.length > 0 && (
          <>
            <div
              className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: 'var(--fg-faint)' }}
            >
              Fields
            </div>
            {fieldColumns.map((f) => (
              <ColumnToggle
                key={f.id}
                label={f.display_name}
                pinned={false}
                checked={!hiddenColumns.has(`f:${f.id}`)}
                onChange={() => onToggle(`f:${f.id}`)}
              />
            ))}
          </>
        )}
        {metaFields.length > 0 && (
          <>
            <div
              className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: 'var(--fg-faint)' }}
            >
              Meta
            </div>
            {metaFields.map((mf) => (
              <ColumnToggle
                key={mf.id}
                label={mf.display_name}
                pinned={false}
                checked={!hiddenColumns.has(`m:${mf.id}`)}
                onChange={() => onToggle(`m:${mf.id}`)}
              />
            ))}
          </>
        )}
        <div
          className="border-t px-2 pb-1 pt-2 text-[10px]"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
        >
          Event, Type, {ROW_METRICS_LABEL}, Actions are pinned
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ColumnToggle({
  label,
  pinned,
  checked,
  onChange,
}: {
  label: string
  pinned: boolean
  checked: boolean
  onChange: () => void
}) {
  return (
    <button
      type="button"
      disabled={pinned}
      onClick={onChange}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed"
      style={{ color: pinned ? 'var(--fg-faint)' : 'var(--fg)' }}
    >
      <span
        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border"
        style={{
          background: checked ? 'var(--accent)' : 'transparent',
          borderColor: checked ? 'var(--accent)' : 'var(--border-strong)',
        }}
      >
        {checked && <Check className="h-2.5 w-2.5" style={{ color: 'var(--accent-fg)' }} />}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {pinned && (
        <span
          className="text-[9px] uppercase tracking-[0.05em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          pinned
        </span>
      )}
    </button>
  )
}
