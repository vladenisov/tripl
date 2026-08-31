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
        {items.map((context) => {
          // A context is the record that this variable is referenced here; the
          // values ride along with it and can be empty. That splits the empty
          // popover into two unrelated facts — this row holds no value, versus
          // values were counted but no example kept — which the single "No
          // examples stored" collapsed into one sentence that answered neither
          // (tripl-xv77.4). The wording below claims no more than this row
          // proves. An empty row cannot tell a column that is genuinely empty
          // from one whose values are recorded elsewhere, so it speaks about
          // this event's field and nothing wider, names no mechanism, and
          // promises no later fill.
          const nothingStored = context.observed_count === 0 && context.values.length === 0
          // The third fact this popover has to keep apart from the other two.
          // Excluding a variable stops scans sampling it but deletes nothing, so
          // a context can hold a real, correct, and permanently frozen reading.
          // Rendering it exactly like a live one would be the same defect as the
          // collapsed empty state: one appearance for two things a reader has to
          // act on differently.
          const isExcluded = context.excluded_from_scans === true
          return (
            <div key={context.id} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono">
                  {`\${${context.variable_name}}`}
                </code>
                <div className="flex shrink-0 items-center gap-1">
                  {/* Its own badge rather than a replacement for the kind badge:
                      the kind still describes the stored values truthfully, and
                      losing "All values" would make a complete frozen set look
                      like a sample of one. */}
                  {isExcluded && (
                    <Badge variant="secondary" className="text-[10px]">
                      Excluded
                    </Badge>
                  )}
                  {/* With nothing counted there is no sample for "Examples" to
                      name, so that case gets its own label. The counted-but-none-
                      kept case keeps "Examples": there the observation is real and
                      only the sample under the badge is missing. */}
                  <Badge variant="outline" className="text-[10px]">
                    {nothingStored
                      ? 'No values'
                      : context.value_kind === 'low'
                        ? 'All values'
                        : 'Examples'}
                  </Badge>
                </div>
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
              ) : nothingStored ? (
                <div className="text-muted-foreground">
                  No value recorded for this field on this event
                </div>
              ) : (
                <div className="text-muted-foreground">No examples stored</div>
              )}
              {/* Two sentences, because the line above them means two different
                  things. With values on screen the reader needs to know they are
                  last-seen and not current; with none, there is no value to date
                  and the honest statement is only that none will arrive. Neither
                  claims the values will be kept forever — Delete still removes
                  the variable and its rows with it. */}
              {isExcluded && (
                <div className="text-muted-foreground">
                  {context.values.length > 0
                    ? 'Last seen before this variable was excluded from scans — scans no longer refresh it.'
                    : 'This variable is excluded from scans — scans no longer record values for it.'}
                </div>
              )}
            </div>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
