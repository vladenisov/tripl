import { useMemo, useRef, useState } from "react"
import type { AlertMessageFormat } from "@/types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { FORMAT_HELP, MESSAGE_FORMAT_OPTIONS, findTemplateVariableToken } from "./constants"

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
}: {
  destinationType: 'slack' | 'telegram' | 'webhook'
  messageFormat: AlertMessageFormat
  onMessageFormatChange: (value: AlertMessageFormat) => void
  title: string
  variableOptions: readonly { name: string; description: string }[]
  helperText: string
  showFormatSelector?: boolean
  placeholder: string
  value: string
  onChange: (value: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [activeToken, setActiveToken] = useState<{ start: number; end: number; query: string } | null>(null)

  const suggestions = useMemo(() => {
    if (!activeToken) return []
    const needle = activeToken.query.toLowerCase()
    return variableOptions.filter(option =>
      !needle || option.name.toLowerCase().includes(needle),
    ).slice(0, 8)
  }, [activeToken, variableOptions])

  const updateToken = (nextValue: string, cursor: number) => {
    setActiveToken(findTemplateVariableToken(nextValue, cursor))
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

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-3">
        <div className="grid gap-2">
          <Label>Message Format</Label>
          {showFormatSelector !== false ? (
            <>
              <Select
                value={messageFormat}
                onValueChange={nextValue => onMessageFormatChange(nextValue as AlertMessageFormat)}
              >
                <SelectTrigger>
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
              <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                {FORMAT_HELP[messageFormat].map(helpLine => (
                  <div key={helpLine} className="font-mono leading-5">
                    {helpLine}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
              Uses the same escaping and channel formatting as the selected message format.
            </div>
          )}
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <Label>{title}</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm">Variables</Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[28rem] space-y-2">
                <div className="text-sm font-medium">Available variables</div>
                <div className="max-h-72 overflow-y-auto space-y-1">
                  {variableOptions.map(option => (
                    <button
                      key={option.name}
                      type="button"
                      className="flex w-full items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                      onClick={() => insertVariable(option.name)}
                    >
                      <span className="font-mono text-xs">{`\${${option.name}}`}</span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={value}
              rows={8}
              placeholder={placeholder}
              onChange={event => {
                onChange(event.target.value)
                updateToken(event.target.value, event.target.selectionStart ?? event.target.value.length)
              }}
              onClick={event => updateToken(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
              onKeyUp={event => updateToken(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
            />
            {activeToken && suggestions.length > 0 && (
              <div className="absolute inset-x-0 top-full z-50 mt-2 rounded-md border bg-popover p-1 shadow-md">
                {suggestions.map(option => (
                  <button
                    key={option.name}
                    type="button"
                    className="flex w-full items-start justify-between gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-muted"
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => insertVariable(option.name)}
                  >
                    <span className="font-mono text-xs">{`\${${option.name}}`}</span>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {helperText}
          </p>
        </div>
      </div>
    </div>
  )
}
