import { CheckCircle2, RotateCcw, XCircle } from 'lucide-react'
import type { SettingSource } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SCard } from '@/components/settings/kit'
import { RESET_FIELDS, SECTION_LABELS, type SectionKey } from './serviceSettingsHelpers'

/**
 * Small shared bits for the Instance (service) settings sections. The card
 * chrome, fields and controls now come from the redesign kit
 * (`@/components/settings/kit`): each section is composed of titled `SCard`
 * sub-cards with `Field` / `ToggleRow` / `TextInput` / `Select` / `RadioCards`.
 * What stays here is the override/env source badge, the AI connection-test
 * status badge, and the section-level "reset to defaults" card.
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
          ? 'inline-flex items-center gap-1 text-xs text-success'
          : 'inline-flex items-center gap-1 text-xs text-muted-foreground'
      }
    >
      {active ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : <XCircle className="h-3 w-3" aria-hidden="true" />}
      {label}
    </span>
  )
}

/**
 * Section-level "reset to defaults" card, rendered once, last, below every
 * sub-card it can null.
 *
 * It used to be a neutral footer on the section's FIRST sub-card while it reset
 * the whole section: on Security & access it sat in "Sessions" (3 fields) and
 * reverted all 13 security overrides, including Registration in the card above
 * it and the CSP and rate limits in the cards below (tripl-ifiy). The count and
 * the danger tone here state the blast radius the position used to hide.
 */
export function ResetSectionCard({
  section,
  onReset,
  resetting,
}: {
  section: SectionKey
  onReset: () => void
  resetting: boolean
}) {
  const label = SECTION_LABELS[section]
  return (
    <SCard
      tone="danger"
      title={`Reset ${label} to defaults`}
      description={`Clears all ${RESET_FIELDS[section].length} ${label} overrides at once — every field in every card above falls back to its environment variable.`}
      footer={
        <>
          <Button type="button" variant="outline" size="sm" onClick={onReset} disabled={resetting}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </Button>
          <span className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
            Applies immediately — it does not wait for Save changes.
          </span>
        </>
      }
    />
  )
}
