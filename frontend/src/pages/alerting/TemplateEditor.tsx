import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { AlertDestinationType, AlertMessageFormat } from "@/types"
import { AnchoredListbox } from "@/components/ui/anchored-listbox"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { FORMAT_HELP, MESSAGE_FORMAT_OPTIONS, findTemplateVariableToken, unknownTemplateVariables } from "./constants"
import { fieldErrorId, fieldErrorProps } from "./fieldErrors"

export function TemplateEditor({
  destinationType,
  messageFormat,
  onMessageFormatChange,
  title,
  variableOptions,
  helperText,
  showFormatSelector,
  placeholder,
  value,
  onChange,
  error,
}: {
  /**
   * The channel the rule routes to, or null before one is picked. The format
   * choices are per channel, so none are offered until there is one: falling
   * back to the first destination showed formats for a channel the reader had
   * never chosen (ALR-4).
   */
  destinationType: AlertDestinationType | null
  messageFormat: AlertMessageFormat
  onMessageFormatChange: (value: AlertMessageFormat) => void
  title: string
  variableOptions: readonly { name: string; description: string }[]
  helperText: string
  showFormatSelector?: boolean
  placeholder: string
  value: string
  onChange: (value: string) => void
  /** A server rejection that names this template. */
  error?: string | null
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const [activeToken, setActiveToken] = useState<{ start: number; end: number; query: string } | null>(null)
  // Which suggestion the arrow keys are on. The textarea declared
  // role="combobox" and handled none of the keys that role promises, so a
  // keyboard user could see the suggestions and not reach them (ALR-19).
  const [activeIndex, setActiveIndex] = useState(0)
  // One id per instance. The rule dialog renders two of these, and a fixed
  // `id="msg-format-label"` gave the document two elements with one id, so
  // `aria-labelledby` resolved to the first for both (ALR-18).
  const instanceId = useId()
  const formatLabelId = `${instanceId}-format-label`
  // Per instance too, for the same reason as the label: the title is not unique.
  const textareaId = `${instanceId}-template`
  const listboxId = `${textareaId}-suggestions`
  const optionId = (index: number) => `${listboxId}-${index}`

  const suggestions = useMemo(() => {
    if (!activeToken) return []
    const needle = activeToken.query.toLowerCase()
    return variableOptions.filter(option =>
      !needle || option.name.toLowerCase().includes(needle),
    ).slice(0, 8)
  }, [activeToken, variableOptions])
  const listOpen = activeToken !== null && suggestions.length > 0
  // Clamped at read time, so a list that shrank as the query grew cannot
  // leave the highlight past its end.
  const highlighted = Math.min(activeIndex, Math.max(suggestions.length - 1, 0))

  // Checked against the same list the suggestions come from, so a typo such
  // as `${scope_nme}` — or an item variable in the message template — is named
  // under this editor while typing, not as a 422 after submit (ALR-21). A
  // warning rather than a block: the backend owns the final word, and a list
  // that fell behind it must not lock a valid template out.
  const unknownVariables = useMemo(
    () => unknownTemplateVariables(value, variableOptions),
    [value, variableOptions],
  )
  const warningId = `${textareaId}-unknown`
  const describedBy = [
    unknownVariables.length > 0 ? warningId : null,
    error ? fieldErrorId(textareaId) : null,
  ].filter(Boolean).join(' ') || undefined

  const updateToken = (nextValue: string, cursor: number) => {
    const next = findTemplateVariableToken(nextValue, cursor)
    // A different query is a different list; start it from the top.
    if (next?.query !== activeToken?.query) setActiveIndex(0)
    setActiveToken(next)
  }

  const insertVariable = (variableName: string) => {
    const textarea = textareaRef.current
    const currentValue = value
    const fallbackPosition = textarea?.selectionStart ?? currentValue.length
    const start = activeToken?.start ?? fallbackPosition
    const end = activeToken?.end ?? fallbackPosition
    const insertion = `\${${variableName}}`
    const nextValue = currentValue.slice(0, start) + insertion + currentValue.slice(end)
    onChange(nextValue)
    setActiveToken(null)

    requestAnimationFrame(() => {
      const nextCursor = start + insertion.length
      textarea?.focus()
      textarea?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!listOpen) return
    const last = suggestions.length - 1
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex(highlighted >= last ? 0 : highlighted + 1)
        return
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex(highlighted <= 0 ? last : highlighted - 1)
        return
      case 'Enter':
      case 'Tab': {
        const option = suggestions[highlighted]
        if (!option) return
        event.preventDefault()
        insertVariable(option.name)
        return
      }
      case 'Escape':
        // The dialog around this editor stands down for an open list (see
        // RuleEditorDialog's `onEscapeKeyDown`), so Escape closes the list
        // that covers the helper text, not the whole form.
        event.preventDefault()
        setActiveToken(null)
        return
    }
  }

  const formatSelector = showFormatSelector !== false
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3">
        <div className="grid gap-2">
          {formatSelector && destinationType ? (
            <>
              <Label id={formatLabelId}>Message format</Label>
              <Select
                value={messageFormat}
                onValueChange={nextValue => onMessageFormatChange(nextValue as AlertMessageFormat)}
              >
                <SelectTrigger aria-labelledby={formatLabelId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MESSAGE_FORMAT_OPTIONS[destinationType].map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="rounded-md border bg-muted/20 p-3 text-body-sm text-muted-foreground">
                {FORMAT_HELP[messageFormat].map(helpLine => (
                  <div key={helpLine} className="font-mono leading-5">
                    {helpLine}
                  </div>
                ))}
              </div>
            </>
          ) : formatSelector ? (
            <div className="rounded-md border bg-muted/20 p-3 text-body-sm text-muted-foreground">
              Pick a destination to choose a message format — the choices depend on the channel.
            </div>
          ) : (
            // No "Message format" label here: it labelled a static note, not
            // a control (ALR-18).
            <div className="rounded-md border bg-muted/20 p-3 text-body-sm text-muted-foreground">
              Uses the same escaping and channel formatting as the selected message format.
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor={textareaId}>{title}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm">Variables</Button>
              </PopoverTrigger>
              {/* Capped at the viewport: 28rem is 448px, wider than a 375px
                  phone, and Radix clamps the position but not the width, so
                  the list ran off screen with its descriptions cut (ALR-20). */}
              <PopoverContent align="end" className="w-[min(28rem,calc(100vw-2rem))] space-y-2">
                <div className="text-body font-medium">Available variables</div>
                <div className="max-h-72 overflow-y-auto space-y-1">
                  {variableOptions.map(option => (
                    <button
                      key={option.name}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left text-body hover:bg-muted"
                      onClick={() => insertVariable(option.name)}
                    >
                      <span className="font-mono text-body-sm">{`\${${option.name}}`}</span>
                      <span className="text-body-sm text-muted-foreground">{option.description}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div ref={fieldRef} className="relative">
            <Textarea
              ref={textareaRef}
              id={textareaId}
              role="combobox"
              aria-expanded={listOpen}
              aria-autocomplete="list"
              aria-controls={listboxId}
              aria-activedescendant={listOpen ? optionId(highlighted) : undefined}
              {...fieldErrorProps(textareaId, error)}
              aria-describedby={describedBy}
              value={value}
              rows={8}
              placeholder={placeholder}
              onChange={event => {
                onChange(event.target.value)
                updateToken(event.target.value, event.target.selectionStart ?? event.target.value.length)
              }}
              onKeyDown={handleKeyDown}
              onClick={event => updateToken(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onKeyUp={event => {
                // The list's own keys have been handled on the way down; a
                // re-read here would re-open the list Escape just closed.
                if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return
                updateToken(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)
              }}
              onBlur={() => setActiveToken(null)}
            />
            {/* Portalled and anchored to the field (DS-35): inline, the list
                sat under the dialog's scroll clip and z-order. */}
            <AnchoredListbox
              id={listboxId}
              open={listOpen}
              anchorRef={fieldRef}
              onDismiss={() => setActiveToken(null)}
              ariaLabel="Variable suggestions"
              className="max-h-72"
            >
                {suggestions.map((option, index) => (
                  <button
                    key={option.name}
                    type="button"
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === highlighted}
                    // Out of the Tab order: the list is driven from the
                    // textarea through aria-activedescendant.
                    tabIndex={-1}
                    className={`flex w-full items-start justify-between gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-surface-hover ${index === highlighted ? 'bg-surface-hover' : ''}`}
                    // Keep focus in the textarea, where the arrow keys live.
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => insertVariable(option.name)}
                  >
                    <span className="font-mono text-body-sm">{`\${${option.name}}`}</span>
                    <span className="text-body-sm text-muted-foreground">{option.description}</span>
                  </button>
                ))}
            </AnchoredListbox>
          </div>
          {unknownVariables.length > 0 && (
            <p id={warningId} className="text-body-sm text-warning">
              {unknownVariables.length === 1 ? 'Unknown variable' : 'Unknown variables'}{' '}
              {unknownVariables.map(name => `\${${name}}`).join(', ')} — this template does not
              offer {unknownVariables.length === 1 ? 'it' : 'them'}, so saving will be refused.
              Pick from Variables.
            </p>
          )}
          {error && (
            <p id={fieldErrorId(textareaId)} className="text-body-sm text-destructive">{error}</p>
          )}
          <p className="text-body-sm text-muted-foreground">
            {helperText}
          </p>
        </div>
      </div>
    </div>
  )
}
