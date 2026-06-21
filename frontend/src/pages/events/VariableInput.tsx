import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'

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
  variables: { name: string; label: string }[]
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
              <code className="font-mono text-primary">${'{'}${v.name}{'}'}</code>
              <span className="text-muted-foreground">{v.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
