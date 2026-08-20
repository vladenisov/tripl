import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { INPUT_BASE, INPUT_DISABLED } from '@/components/settings/input-style'

/**
 * Column-name input backed by data-source schema suggestions. Free typing is
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
    onChange(name)
    setOpen(false)
    setHighlight(0)
  }

  const handleChange = (next: string) => {
    onChange(next)
    setOpen(true)
    setHighlight(0)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!expanded) {
      if (e.key === 'ArrowDown' && filtered.length > 0) {
        e.preventDefault()
        setOpen(true)
        setHighlight(0)
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      pick(filtered[activeIdx])
    } else if (e.key === 'ArrowDown') {
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
        // The disabled cue comes from the shared primitive, not from a local
        // knock-down. This box used to dim itself with `opacity: 0.6`, the same
        // treatment that on the dark theme left a dead field 3/255 of fill and
        // 7/255 of border away from a live one — indistinguishable in a
        // screenshot (tripl-91j6). INPUT_DISABLED is a shape change (no well,
        // dashed border) precisely so it does not depend on that delta.
        style={{ ...INPUT_BASE, ...(disabled ? INPUT_DISABLED : {}) }}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setOpen(true)}
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
