import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { relaxedToJson } from './jsonRelaxed'
import { formatJsonTemplate, templateJsonError, validateJsonWithVars } from './jsonTemplate'
import { SuggestionRow, type VariableSuggestion } from './VariableInput'
import { suggestionMatches } from './utils'

export function JsonEditor({
  id,
  value,
  onChange,
  required,
  variables = [],
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  variables?: VariableSuggestion[]
}) {
  const uid = useId()
  const listboxId = `json-var-listbox-${uid}`
  const errorId = `json-error-${uid}`
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [insertPos, setInsertPos] = useState(0)
  // What the last Format repaired, and the text it replaced. Repairing is a
  // guess about intent, so it is always both reported and undoable.
  const [repair, setRepair] = useState<{ fixes: string[]; previous: string } | null>(null)
  // The server stores JSON as a single canonical line, so a stored value —
  // templated or not — arrives unbroken. Re-indent it on the way in, or every
  // edit session starts with the whole payload on line one.
  const [raw, setRaw] = useState(() => (value ? formatJsonTemplate(value) ?? value : ''))

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

  const insertVar = useCallback((varName: string) => {
    const before = raw.slice(0, insertPos)
    const after = raw.slice(textareaRef.current?.selectionEnd ?? insertPos)
    const dollarIdx = before.lastIndexOf('$')
    const newValue = before.slice(0, dollarIdx) + '${' + varName + '}' + after
    setRaw(newValue)
    setRepair(null)
    const err = validateJsonWithVars(newValue)
    onChange(newValue)
    setError(err)
    setShowMenu(false)
    setTimeout(() => {
      const pos = dollarIdx + varName.length + 3
      textareaRef.current?.setSelectionRange(pos, pos)
      textareaRef.current?.focus()
    }, 0)
  }, [raw, insertPos, onChange])

  const handleChange = (v: string) => {
    const cursor = textareaRef.current?.selectionStart ?? v.length
    setRaw(v)
    setRepair(null)
    if (!v.trim()) {
      onChange('')
      setError(null)
      setShowMenu(false)
      return
    }
    const err = validateJsonWithVars(v)
    onChange(v)
    setError(err)

    if (variables.length > 0) {
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
        insertVar(filtered[highlightIdx].name)
      }
    } else if (e.key === 'Escape') {
      setShowMenu(false)
    }
  }

  const apply = (next: string) => {
    setRaw(next)
    onChange(next)
    setError(validateJsonWithVars(next))
  }

  // Format used to fail silently on anything it could not parse, which read as
  // a dead button. Try strict first — already-valid JSON is only re-indented,
  // never reinterpreted — then the tolerant reader, and failing both, say what
  // is wrong.
  const handleFormat = () => {
    if (!raw.trim()) return

    const strict = formatJsonTemplate(raw)
    if (strict !== null) {
      setRepair(null)
      apply(strict)
      return
    }

    // A malformed ${token} is a mistake to report, not to repair.
    const templateError = templateJsonError(raw)
    if (!templateError) {
      const relaxed = relaxedToJson(raw, variables.map(v => v.name))
      const formatted = relaxed && formatJsonTemplate(relaxed.text)
      if (relaxed && formatted && validateJsonWithVars(formatted) === null) {
        setRepair({ fixes: relaxed.fixes, previous: raw })
        apply(formatted)
        return
      }
    }

    setError(templateError ?? validateJsonWithVars(raw))
  }

  const handleUndoRepair = () => {
    if (!repair) return
    const previous = repair.previous
    setRepair(null)
    apply(previous)
  }

  return (
    <div className="space-y-1">
      <div ref={wrapperRef} className="relative">
        <Textarea
          ref={textareaRef}
          id={id}
          value={raw}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className={`font-mono text-xs ${error ? 'border-destructive' : ''}`}
          rows={4}
          placeholder='{ "key": "value" }'
          required={required}
          spellCheck={false}
          role="combobox"
          aria-invalid={error ? 'true' : 'false'}
          aria-expanded={showMenu && filtered.length > 0}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-describedby={error ? errorId : undefined}
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
                onMouseDown={e => { e.preventDefault(); insertVar(v.name) }}
                className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs ${i === highlightIdx ? 'bg-accent text-accent-foreground' : 'text-popover-foreground hover:bg-accent/50'}`}
              >
                <SuggestionRow suggestion={v} selected={i === highlightIdx} />
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Format sits under the field, not over it: an overlay button covered the
          first line of every payload wider than the box. */}
      <div className="flex items-start justify-between gap-2">
        <p id={errorId} className="min-w-0 text-xs text-destructive">{error}</p>
        <Button type="button" variant="ghost" size="xs" onClick={handleFormat} className="shrink-0">
          Format
        </Button>
      </div>
      {repair && (
        <div className="flex items-start justify-between gap-2" aria-live="polite">
          <p className="min-w-0 text-xs text-muted-foreground">
            Format {repair.fixes.join(', ')}.
          </p>
          <Button type="button" variant="ghost" size="xs" onClick={handleUndoRepair} className="shrink-0">
            Undo
          </Button>
        </div>
      )}
    </div>
  )
}
