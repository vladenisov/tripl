import { Button } from '@/components/ui/button'
import { RANGE_OPTIONS } from '@/lib/metrics'
import { cn } from '@/lib/utils'

/**
 * The 7d / 30d / 90d range picker as one segmented pill group — the shape the
 * Events chart already uses. The monitoring drilldown drew three separate
 * outlined buttons instead, so the two charts' range controls looked like two
 * different widgets (LIVE-26).
 */
export function RangeSegmentedControl({
  value,
  onChange,
  options = RANGE_OPTIONS,
  className,
}: {
  value: number
  onChange: (days: number) => void
  options?: ReadonlyArray<{ label: string; days: number }>
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Time range"
      className={cn('flex items-center gap-1 rounded-lg border bg-background p-1', className)}
    >
      {options.map(option => (
        <Button
          key={option.days}
          type="button"
          variant={value === option.days ? 'default' : 'ghost'}
          size="sm"
          aria-pressed={value === option.days}
          className="h-6 px-2 text-[11px]"
          onClick={() => onChange(option.days)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}
