import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { INPUT_BASE } from '@/components/settings/input-style'

/**
 * Column-name inputs backed by data-source schema suggestions. Free typing is
 * always allowed — the schema cache may lag the warehouse — so the listbox only
 * assists, never restricts. Follows the accessible combobox pattern already
 * used by pages/events/VariableInput (role="combobox" + listbox options).
 */

interface ColumnSuggestInputProps {
  id?: string
  value: string
  onChange: (value: string) => void
  /** Candidate column names; an empty list makes this a plain text input. */
  suggestions: string[]
  placeholder?: string
  disabled?: boolean
  'aria-label'?: string
  /**
   * Chips mode: called with the chosen suggestion (or the free-typed draft on
   * Enter) instead of writing it into the input via onChange.
   */
  onCommit?: (value: string) => void
  /** Chips mode: Backspace pressed while the input is empty (remove last chip). */
  onEmptyBackspace?: () => void
}

/**
 * Controlled mono text input with a substring-filtered suggestion listbox.
 * ArrowUp/ArrowDown move the highlight, Enter picks it, Escape closes; clicking
 * an option picks it without losing focus.
 */
export function ColumnSuggestInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
  onCommit,
  onEmptyBackspace,
}: ColumnSuggestInputProps) {
  const uid = useId()
  const listboxId = `column-listbox-${uid}`
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)

  const filtered = useMemo(() => {
    const query = value.trim().toLowerCase()
    return suggestions.filter(name => name.toLowerCase().includes(query))
  }, [suggestions, value])

  const expanded = open && filtered.length > 0
  // The highlight index can outlive a shrinking filter; clamp instead of
  // resetting so ArrowUp/Down stay stable while typing.
  const activeIdx = Math.min(highlight, filtered.length - 1)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const pick = (name: string) => {
    if (onCommit) onCommit(name)
    else onChange(name)
    setOpen(false)
    setHighlight(0)
  }

  const handleChange = (next: string) => {
    onChange(next)
    setOpen(true)
    setHighlight(0)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && value === '' && onEmptyBackspace) {
      onEmptyBackspace()
      return
    }
    if (e.key === 'Enter') {
      if (expanded) {
        e.preventDefault()
        pick(filtered[activeIdx])
      } else if (onCommit && value.trim()) {
        // Chips mode: Enter commits free text even when nothing matches.
        e.preventDefault()
        onCommit(value)
      }
      return
    }
    if (!expanded) {
      if (e.key === 'ArrowDown' && filtered.length > 0) {
        e.preventDefault()
        setOpen(true)
        setHighlight(0)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight(Math.min(activeIdx + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight(Math.max(activeIdx - 1, 0))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-activedescendant={expanded ? `${listboxId}-opt-${activeIdx}` : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        className="mono"
        style={{ ...INPUT_BASE, ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Chips mode: a value typed but never turned into a chip (no Enter /
          // no suggestion pick) would otherwise be silently dropped when focus
          // leaves — e.g. clicking "Save". Flush the draft on blur so it is not
          // lost. Suggestion clicks use onMouseDown preventDefault, so they
          // commit via pick() without ever blurring here.
          if (onCommit && value.trim()) onCommit(value)
        }}
      />
      {expanded && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Column suggestions"
          className="absolute z-50 mt-1 max-h-[220px] w-full overflow-y-auto rounded-[7px] border p-1 shadow-md"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          {filtered.map((name, i) => (
            <button
              key={name}
              id={`${listboxId}-opt-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(name)}
              onMouseEnter={() => setHighlight(i)}
              className="mono flex w-full items-center rounded-[5px] px-2 py-[5px] text-left text-[12px]"
              style={{
                background: i === activeIdx ? 'var(--surface-hover)' : 'transparent',
                color: 'var(--fg)',
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ColumnChipsInputProps {
  id?: string
  /** Chosen column names, in order. */
  value: string[]
  onChange: (next: string[]) => void
  suggestions: string[]
  placeholder?: string
  disabled?: boolean
}

/**
 * Multi-column chip editor: chosen columns render as removable chips above a
 * {@link ColumnSuggestInput} that adds the next one. Picking a suggestion or
 * pressing Enter adds (comma-separated free text adds several); Backspace on
 * the empty input removes the last chip.
 */
export function ColumnChipsInput({
  id,
  value,
  onChange,
  suggestions,
  placeholder,
  disabled,
}: ColumnChipsInputProps) {
  const [draft, setDraft] = useState('')

  const remaining = useMemo(
    () => suggestions.filter(name => !value.includes(name)),
    [suggestions, value],
  )

  const addColumns = (raw: string) => {
    const next = [...value]
    for (const part of raw.split(',')) {
      const name = part.trim()
      if (name && !next.includes(name)) next.push(name)
    }
    if (next.length !== value.length) onChange(next)
    setDraft('')
  }

  const removeColumn = (name: string) => {
    onChange(value.filter(column => column !== name))
  }

  return (
    <div>
      {value.length > 0 && (
        <div className="mb-[6px] flex flex-wrap gap-[6px]">
          {value.map(name => (
            <Chip key={name} size="md" className="mono">
              {name}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                disabled={disabled}
                onClick={() => removeColumn(name)}
                className="inline-flex items-center rounded-full transition-colors hover:text-[var(--fg)]"
              >
                <X size={11} />
              </button>
            </Chip>
          ))}
        </div>
      )}
      <ColumnSuggestInput
        id={id}
        value={draft}
        onChange={setDraft}
        suggestions={remaining}
        placeholder={value.length === 0 ? placeholder : undefined}
        disabled={disabled}
        onCommit={addColumns}
        onEmptyBackspace={() => {
          if (value.length > 0) removeColumn(value[value.length - 1])
        }}
      />
    </div>
  )
}
