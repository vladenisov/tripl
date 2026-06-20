import { CheckCircle2, RotateCcw, XCircle } from 'lucide-react'
import type { SettingSource } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

/**
 * Small shared bits for the Instance (service) settings sections. The card
 * chrome, fields and controls now come from the redesign kit
 * (`@/components/settings/kit`): each section is composed of titled `SCard`
 * sub-cards with `Field` / `ToggleRow` / `TextInput` / `Select` / `RadioCards`.
 * What stays here is the override/env source badge, the AI connection-test
 * status badge, and the per-section "reset to defaults" footer.
 */

/** Override vs. environment-default origin of a single setting. */
export function SourceBadge({ source }: { source: SettingSource }) {
  return (
    <Badge variant={source === 'override' ? 'info' : 'outline'} className="text-[10px]">
      {source === 'override' ? 'Override' : 'Env'}
    </Badge>
  )
}

/** Pass/fail result chip for the "Test AI" connection check. */
export function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={
        active
          ? 'inline-flex items-center gap-1 text-xs text-emerald-600'
          : 'inline-flex items-center gap-1 text-xs text-muted-foreground'
      }
    >
      {active ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

/**
 * Footer content for an `SCard`: resets the whole section's overrides back to
 * the environment defaults, with an explanatory note. Rendered once per
 * section (on its first sub-card).
 */
export function ResetRow({
  onReset,
  resetting,
  note = 'Unset fields fall back to environment variables.',
}: {
  onReset: () => void
  resetting?: boolean
  note?: string
}) {
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={onReset} disabled={resetting}>
        <RotateCcw className="h-3.5 w-3.5" />
        Reset to defaults
      </Button>
      <span className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        {note}
      </span>
    </>
  )
}
