import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { suggestionMatches } from './utils'

/** Structural subset of Variable — full Variable objects satisfy it. */
export interface VariableSuggestion {
  name: string
  description?: string
  bindings?: string[]
  allowed_values?: string[]
}

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

export function VariableInput({
  id,
  value,
  onChange,
  variables,
  required,
  type,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  variables: VariableSuggestion[]
  required?: boolean
  type?: string
}) {
  const uid = useId()
  const listboxId = `variable-listbox-${uid}`
  const ref = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [insertPos, setInsertPos] = useState(0)

  const filtered = useMemo(
    () => variables.filter(v => suggestionMatches(v, filter)),
    [variables, filter],
  )

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
      if (filtered.length > 0) {
        e.preventDefault()
        insert(filtered[highlightIdx].name)
      }
    } else if (e.key === 'Escape') {
      setShowMenu(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <Input
        ref={ref}
        id={id}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        required={required}
        type={type}
        role="combobox"
        aria-expanded={showMenu && filtered.length > 0}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={showMenu && filtered.length > 0 ? `${listboxId}-opt-${highlightIdx}` : undefined}
      />
      {showMenu && filtered.length > 0 && (
        <div id={listboxId} role="listbox" className="absolute z-50 mt-1 w-full rounded-md border bg-popover p-1 shadow-md">
          {filtered.map((v, i) => (
            <button
              key={v.name}
              id={`${listboxId}-opt-${i}`}
              type="button"
              role="option"
              aria-selected={i === highlightIdx}
              onMouseDown={e => { e.preventDefault(); insert(v.name) }}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs ${i === highlightIdx ? 'bg-accent text-accent-foreground' : 'text-popover-foreground hover:bg-accent/50'}`}
            >
              <SuggestionRow suggestion={v} selected={i === highlightIdx} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
