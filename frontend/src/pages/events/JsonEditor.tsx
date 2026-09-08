import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/lib/utils'
import { SuggestionRow, type VariableSuggestion } from './VariableInput'
import { suggestionMatches } from './utils'

const TEMPLATE_TOKEN_PATTERN = /\$\{([^}]*)\}/g
const TEMPLATE_TOKEN_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const JSON_TEMPLATE_VALUE_PATTERN = /"\$\{[A-Za-z_][A-Za-z0-9_.-]*\}"|\$\{[A-Za-z_][A-Za-z0-9_.-]*\}/g
const JSON_TEMPLATE_KEY_PATTERN = /"\$\{[A-Za-z_][A-Za-z0-9_.-]*\}"\s*:/

const SENTINEL_BASE = '__TRIPL_VAR_'

function templateJsonError(text: string): string | null {
  const tokens = [...text.matchAll(TEMPLATE_TOKEN_PATTERN)].map(match => match[1])
  if (tokens.some(token => !TEMPLATE_TOKEN_NAME_PATTERN.test(token))) {
    return 'Variable tokens may use letters, digits, underscores, dots, or hyphens.'
  }
  const templateValues = text.match(JSON_TEMPLATE_VALUE_PATTERN) ?? []
  if (templateValues.length !== tokens.length) {
    return 'Variable templates must occupy a complete JSON value.'
  }
  if (JSON_TEMPLATE_KEY_PATTERN.test(text)) {
    return 'Variable templates cannot be JSON object keys.'
  }
  return null
}

function validateJsonWithVars(text: string): string | null {
  if (!text.trim()) return null
  const templateError = templateJsonError(text)
  if (templateError) return templateError
  if (!text.includes('${')) {
    try { JSON.parse(text); return null } catch (e) { return getErrorMessage(e) }
  }
  // Replace ${var} placeholders with a sentinel string before validating, so
  // partially-templated JSON parses successfully. Quoted tokens ("${var}")
  // must be swapped together with their quotes or the sentinel doubles them.
  const safe = text.replace(JSON_TEMPLATE_VALUE_PATTERN, '"__var__"')
  try { JSON.parse(safe); return null } catch (e) { return getErrorMessage(e) }
}

/**
 * Re-indent `text` as JSON, carrying any ${var} placeholders through untouched.
 *
 * Returns null when the text is not valid JSON, so every caller decides for
 * itself whether that is worth reporting. Placeholders are stashed behind
 * sentinels before parsing — a bare ${token} is a syntax error to JSON.parse,
 * and a quoted one would come back escaped from JSON.stringify.
 *
 * Each occurrence gets its own numbered sentinel, because the restore replaces
 * a string needle and that only ever swaps the first match.
 */
export function formatJsonTemplate(text: string): string | null {
  if (!text.trim()) return null
  if (templateJsonError(text)) return null
  if (!text.includes('${')) {
    try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return null }
  }

  // A sentinel has to survive the round trip unambiguously, and the input is
  // not enough to check against: a \u005f escape only becomes an underscore
  // after parsing, so a literal can collide with a sentinel that was unique in
  // the source. Lengthen the prefix until every sentinel appears exactly once
  // in the formatted output.
  let prefix = SENTINEL_BASE
  for (let attempt = 0; attempt < 8; attempt++) {
    const stashPrefix = prefix
    const placeholders = new Map<string, string>()
    const safe = text.replace(JSON_TEMPLATE_VALUE_PATTERN, match => {
      const sentinel = `${stashPrefix}${placeholders.size}__`
      placeholders.set(sentinel, match)
      return `"${sentinel}"`
    })

    let formatted: string
    try { formatted = JSON.stringify(JSON.parse(safe), null, 2) } catch { return null }

    const needles = [...placeholders.keys()].map(sentinel => `"${sentinel}"`)
    if (needles.some(needle => formatted.split(needle).length !== 2)) {
      prefix = `_${prefix}`
      continue
    }
    placeholders.forEach((placeholder, sentinel) => {
      formatted = formatted.replace(`"${sentinel}"`, placeholder)
    })
    return formatted
  }
  return null
}

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

  // Format used to fail silently on anything it could not parse, which read as
  // a dead button. Say what is wrong instead — the same message the field
  // shows while typing.
  const handleFormat = () => {
    if (!raw.trim()) return
    const formatted = formatJsonTemplate(raw)
    if (formatted === null) {
      setError(validateJsonWithVars(raw))
      return
    }
    setRaw(formatted)
    onChange(formatted)
    setError(null)
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
    </div>
  )
}
