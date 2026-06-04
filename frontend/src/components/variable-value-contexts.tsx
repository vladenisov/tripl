import { Variable } from 'lucide-react'
import type { EventFieldVariableValue } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export function VariableValueContextTrigger({
  contexts,
}: {
  contexts?: EventFieldVariableValue[]
}) {
  const items = contexts ?? []
  if (items.length === 0) return null

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Observed variable values"
        >
          <Variable className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3 p-3 text-xs">
        {items.map((context) => (
          <div key={context.id} className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono">
                {`\${${context.variable_name}}`}
              </code>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {context.value_kind === 'low' ? 'All values' : 'Examples'}
              </Badge>
            </div>
            <div className="text-muted-foreground">
              {context.source_column} - {context.observed_count} observed
            </div>
            {context.values.length > 0 ? (
              <div className="flex max-h-36 flex-wrap gap-1 overflow-auto">
                {context.values.map((value) => (
                  <span
                    key={value}
                    className="max-w-full truncate rounded border bg-background px-1.5 py-0.5 font-mono"
                    title={value}
                  >
                    {value}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground">No examples stored</div>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  )
}
