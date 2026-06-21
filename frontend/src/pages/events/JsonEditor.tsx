import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/lib/utils'

function validateJsonWithVars(text: string): string | null {
  if (!text.trim()) return null
  if (!text.includes('${')) {
    try { JSON.parse(text); return null } catch (e) { return getErrorMessage(e) }
  }
  // Replace ${var} placeholders with a sentinel string before validating, so
  // partially-templated JSON parses successfully.
  const safe = text.replace(/\$\{[^}]*\}/g, '"__var__"')
  try { JSON.parse(safe); return null } catch (e) { return getErrorMessage(e) }
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
  variables?: { name: string; label: string }[]
}) {
  const uid = useId()
  const listboxId = `json-var-listbox-${uid}`
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [showMenu, setShowMenu] = useState(false)
  const [filter, setFilter] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [insertPos, setInsertPos] = useState(0)
  const [raw, setRaw] = useState(() => {
    if (!value) return ''
    if (!value.includes('${')) {
      try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
    }
    return value
  })

  const filtered = useMemo(
    () => variables.filter(
      v => v.name.toLowerCase().includes(filter.toLowerCase())
        || v.label.toLowerCase().includes(filter.toLowerCase()),
    ),
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

  const handleFormat = () => {
    if (!raw.trim()) return
    if (!raw.includes('${')) {
      try {
        const formatted = JSON.stringify(JSON.parse(raw), null, 2)
        setRaw(formatted)
        onChange(formatted)
        setError(null)
      } catch { /* keep as is */ }
      return
    }
    // Round-trip ${var} placeholders through unique sentinels so JSON.stringify
    // doesn't escape them — then put them back as-is.
    const placeholders: string[] = []
    const safe = raw.replace(/\$\{[^}]*\}/g, (match) => {
      const idx = placeholders.length
      placeholders.push(match)
      return `"__TRIPL_VAR_${idx}__"`
    })
    try {
      let formatted = JSON.stringify(JSON.parse(safe), null, 2)
      placeholders.forEach((ph, idx) => {
        formatted = formatted.replace(`"__TRIPL_VAR_${idx}__"`, ph)
      })
      setRaw(formatted)
      onChange(formatted)
      setError(null)
    } catch { /* keep as is */ }
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
          aria-expanded={showMenu && filtered.length > 0}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-activedescendant={showMenu && filtered.length > 0 ? `${listboxId}-opt-${highlightIdx}` : undefined}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleFormat}
          className="absolute right-1.5 top-1.5 h-6 text-[10px]"
        >
          Format
        </Button>
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
                <code className="font-mono text-primary">${'{'}${v.name}{'}'}</code>
                <span className="text-muted-foreground">{v.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
