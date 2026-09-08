import { useState } from 'react'
import { X } from 'lucide-react'

const DEFAULT_INVALID_MESSAGE = 'That value is not accepted here.'

export interface ChipListInputProps {
  values: string[]
  onChange: (next: string[]) => void
  placeholder: string
  ariaLabel: string
  validate?: (value: string) => boolean
  /** Shown when `validate` rejects the draft. */
  invalidMessage?: string
  inputId?: string
}

/**
 * A list of short values entered one at a time — the interaction Tags already
 * had, and the one the analyst named for several Jira keys on one event.
 *
 * Values are kept EXACTLY as typed. Tags lower-case theirs, which is right for
 * a free-form label and wrong for everything else here: it would turn WND-4770
 * into wnd-4770, and a documented value into a different string.
 */
export function ChipListInput({
  values,
  onChange,
  placeholder,
  ariaLabel,
  validate,
  invalidMessage = DEFAULT_INVALID_MESSAGE,
  inputId,
}: ChipListInputProps) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = () => {
    const value = draft.trim()
    if (!value) return
    if (validate && !validate(value)) {
      setInvalid(true)
      return
    }
    if (!values.includes(value)) onChange([...values, value])
    setDraft('')
    setInvalid(false)
  }
  return (
    <div>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1">
        {values.map(value => (
          <span
            key={value}
            className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter(v => v !== value))}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          aria-label={ariaLabel}
          className="h-6 min-w-28 flex-1 bg-transparent text-sm outline-none"
          value={draft}
          onChange={e => {
            setDraft(e.target.value)
            setInvalid(false)
          }}
          // Enter adds a chip and nothing else: this control is mounted inside
          // forms whose own submit saves something much larger.
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
          placeholder={placeholder}
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-destructive">{invalidMessage}</p>}
    </div>
  )
}
