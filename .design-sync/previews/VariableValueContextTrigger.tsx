import {
  VariableValueContextTrigger,
  Badge,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from 'frontend'
import { Variable } from 'lucide-react'

const contexts = [
  {
    id: 'ctx-1',
    variable_id: 'var-plan',
    variable_name: 'plan_tier',
    source_column: 'subscription.plan',
    value_kind: 'low' as const,
    observed_count: 4,
    values: ['free', 'pro', 'team', 'enterprise'],
  },
  {
    id: 'ctx-2',
    variable_id: 'var-region',
    variable_name: 'region',
    source_column: 'geo.region_code',
    value_kind: 'high' as const,
    observed_count: 38,
    values: ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-southeast-2'],
  },
]

// The shipped trigger as used in an event-field row: a compact icon button
// that opens the observed-values popover on click.
export const InFieldRow = () => (
  <div
    style={{
      width: 420,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '10px 14px',
      borderRadius: 10,
      border: '1px solid var(--border)',
      background: 'var(--surface)',
    }}
  >
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg)' }}>
      {'revenue = ${plan_tier} × seats'}
    </code>
    <VariableValueContextTrigger contexts={contexts} />
  </div>
)

// The same popover anatomy, rendered open, to show the full content the
// trigger reveals: variable token, All values / Examples badge, source
// column + observed count, and the value chips.
export const OpenPanel = () => (
  <div style={{ paddingBottom: 220 }}>
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <button
          type="button"
          style={{
            display: 'inline-flex',
            height: 24,
            width: 24,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--fg-muted)',
          }}
          aria-label="Observed variable values"
        >
          <Variable className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3 p-3 text-xs">
        {contexts.map((context) => (
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
          </div>
        ))}
      </PopoverContent>
    </Popover>
  </div>
)
