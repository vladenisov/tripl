import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useEvDescribedBy } from './evFieldContext'
import { TEXT_INPUT_CLASS } from './eventFormLayout'
import { filterVariableSuggestions, type VariableSuggestion } from './variableSuggestions'

export type { VariableSuggestion }

export function SuggestionRow({
  suggestion,
  selected = false,
}: {
  suggestion: VariableSuggestion
  selected?: boolean
}) {
  const bindings = suggestion.bindings ?? []
  const values = suggestion.allowed_values ?? []
  const detailClassName = selected ? 'text-accent-foreground/80' : 'text-muted-foreground/80'
  return (
    <>
      <code className={`shrink-0 font-mono ${selected ? 'text-accent-foreground' : 'text-primary'}`}>
        {`\${${suggestion.name}}`}
      </code>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden text-left">
        {suggestion.description && (
          <span
            title={suggestion.description}
            className={`w-full truncate ${selected ? 'text-accent-foreground/80' : 'text-muted-foreground'}`}
          >
            {suggestion.description}
          </span>
        )}
        {bindings.length > 0 && (
          <span className={`w-full truncate font-mono text-[10px] ${detailClassName}`}>{bindings.join(' · ')}</span>
        )}
        {values.length > 0 && (
          <span className={`w-full truncate font-mono text-[10px] ${detailClassName}`}>{values.slice(0, 3).join(' · ')}</span>
        )}
      </span>
    </>
  )
}

/**
 * The dropdown under a variable-aware input, shared by the single-line input and
 * the JSON editor so the two cannot drift. Height-limited and scrolling, and the
 * highlighted option is kept in view as the arrow keys move it (EVT-24).
 */
export function SuggestionListbox({
  id,
  suggestions,
  highlightIdx,
  onPick,
}: {
  id: string
  suggestions: VariableSuggestion[]
  highlightIdx: number
  onPick: (name: string) => void
}) {
  useEffect(() => {
    const active = document.getElementById(`${id}-opt-${highlightIdx}`)
    // Optional call: jsdom does not implement scrollIntoView.
    active?.scrollIntoView?.({ block: 'nearest' })
  }, [id, highlightIdx])
  return (
    <div
      id={id}
      role="listbox"
      className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
    >
      {suggestions.map((v, i) => (
        <button
          key={v.name}
          id={`${id}-opt-${i}`}
          type="button"
          role="option"
          aria-selected={i === highlightIdx}
          onMouseDown={e => { e.preventDefault(); onPick(v.name) }}
          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs ${i === highlightIdx ? 'bg-accent text-accent-foreground' : 'text-popover-foreground hover:bg-accent/50'}`}
        >
          <SuggestionRow suggestion={v} selected={i === highlightIdx} />
        </button>
      ))}
    </div>
  )
}

// Input types that may carry role="combobox" (ARIA in HTML). A date or number
// input is a different widget, and the autocomplete means nothing on it.
const COMBOBOX_TYPES = new Set(['text', 'search', 'url', 'email', 'tel'])

export function VariableInput({
  id,
  value,
  onChange,
  variables,
  required,
  ariaRequired,
  type = 'text',
  inputMode,
  className,
  invalid,
  describedBy: ownDescribedBy,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  variables: VariableSuggestion[]
  required?: boolean
  /** Announced as required without the browser enforcing it. */
  ariaRequired?: boolean
  type?: string
  inputMode?: 'text' | 'decimal' | 'numeric' | 'url'
  className?: string
  invalid?: boolean
  /** Ids of this control's own messages, merged with its form row's. */
  describedBy?: string
}) {
  const uid = useId()
  const listboxId = `variable-listbox-${uid}`
  const ref = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [insertPos, setInsertPos] = useState(0)
  const describedBy = useEvDescribedBy(ownDescribedBy)
  const combobox = COMBOBOX_TYPES.has(type)

  const filtered = useMemo(
    () => (combobox ? filterVariableSuggestions(variables, filter) : []),
    [combobox, variables, filter],
  )
  const open = showMenu && filtered.length > 0

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const insert = useCallback((varName: string) => {
    const before = value.slice(0, insertPos)
    const after = value.slice(ref.current?.selectionEnd ?? insertPos)
    const dollarIdx = before.lastIndexOf('$')
    const newValue = before.slice(0, dollarIdx) + '${' + varName + '}' + after
    onChange(newValue)
    setShowMenu(false)
    setTimeout(() => {
      const pos = dollarIdx + varName.length + 3
      ref.current?.setSelectionRange(pos, pos)
      ref.current?.focus()
    }, 0)
  }, [value, insertPos, onChange])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value
    const cursor = e.target.selectionStart ?? v.length
    onChange(v)

    const before = v.slice(0, cursor)
    const dollarIdx = before.lastIndexOf('$')
    if (dollarIdx >= 0) {
      const afterDollar = before.slice(dollarIdx + 1)
      if (!afterDollar.includes('}') && !/\s/.test(afterDollar)) {
        setFilter(afterDollar.replace(/^\{/, ''))
        setInsertPos(cursor)
        setShowMenu(true)
        setHighlightIdx(0)
        return
      }
    }
    setShowMenu(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showMenu) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const choice = filtered[highlightIdx]
      if (choice) {
        e.preventDefault()
        insert(choice.name)
      }
    } else if (e.key === 'Escape') {
      setShowMenu(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        required={required}
        aria-required={ariaRequired && !required ? true : undefined}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        type={type}
        inputMode={inputMode}
        // The form's own control style, not the shared Input: the two sat side
        // by side at different heights and borders (LIVE-30).
        className={cn(TEXT_INPUT_CLASS, className)}
        {...(combobox
          ? {
              role: 'combobox',
              'aria-expanded': open,
              'aria-haspopup': 'listbox' as const,
              'aria-autocomplete': 'list' as const,
              'aria-controls': listboxId,
              'aria-activedescendant': open ? `${listboxId}-opt-${highlightIdx}` : undefined,
            }
          : {})}
      />
      {open && (
        <SuggestionListbox id={listboxId} suggestions={filtered} highlightIdx={highlightIdx} onPick={insert} />
      )}
    </div>
  )
}
