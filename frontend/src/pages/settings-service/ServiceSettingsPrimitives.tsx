import { useId } from 'react'
import { CheckCircle2, RotateCcw, XCircle } from 'lucide-react'
import type { SettingSource } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SCard, TextInput } from '@/components/settings/kit'
import {
  SECTION_LABELS,
  numberFieldError,
  resetCardDescription,
  type SectionKey,
} from './serviceSettingsHelpers'

/**
 * Small shared bits for the Instance (service) settings sections. The card
 * chrome, fields and controls now come from the redesign kit
 * (`@/components/settings/kit`): each section is composed of titled `SCard`
 * sub-cards with `Field` / `ToggleRow` / `TextInput` / `Select` / `RadioCards`.
 * What stays here is the setting-source badge, the AI connection-test status
 * badge, and the section-level "reset to defaults" card.
 */

const SOURCE_BADGE: Record<
  SettingSource,
  { label: string; variant: 'info' | 'outline' | 'secondary'; title: string }
> = {
  override: {
    label: 'Override',
    variant: 'info',
    title: 'Stored in this instance’s settings table. A section reset clears it.',
  },
  env: {
    label: 'Env',
    variant: 'outline',
    title:
      'Delivered by an environment variable or .env line: the value differs from the built-in default.',
  },
  default: {
    label: 'Default',
    variant: 'secondary',
    title:
      'The built-in default. Either nothing was delivered for this setting, or what was delivered happens to match the default — from here the two are indistinguishable.',
  },
}

/**
 * Where this setting's value came from: a stored override, the environment, or
 * the code default.
 *
 * There used to be no third state, so every field with no stored override was
 * badged "Env" — including ones nothing had ever delivered, which is how an
 * instance could assert it had been told where to send embeddings when it had
 * not (tripl-wkwv.2). "Default" is deliberately the weaker claim of the two: it
 * says the value equals the built-in default, not that nothing arrived, and the
 * tooltip says so rather than letting the label overreach.
 */
export function SourceBadge({ source }: { source: SettingSource }) {
  const { label, variant, title } = SOURCE_BADGE[source]
  return (
    <Badge variant={variant} className="text-[10px]" title={title}>
      {label}
    </Badge>
  )
}

/**
 * Pass/fail result chip for the AI and email connection checks. A failure is
 * the danger tone, not helper-text grey: a failed test is the reason the card
 * exists, and it used to read weaker than a pass.
 */
export function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={
        active
          ? 'inline-flex items-center gap-1 text-xs text-success'
          : 'inline-flex items-center gap-1 text-xs text-destructive'
      }
    >
      {active ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : <XCircle className="h-3 w-3" aria-hidden="true" />}
      {label}
    </span>
  )
}

/** Placeholder cards while the instance settings (or their chunk) load. */
export function InstanceSettingsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading instance settings">
      {[3, 2].map((rows, card) => (
        <SCard key={card}>
          <div className="px-[18px] py-4">
            <Skeleton className="h-3.5 w-32" />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <div
              key={row}
              className="flex flex-col gap-2 px-[18px] py-[15px] sm:flex-row sm:items-center sm:gap-6"
              style={{ borderTop: '1px solid var(--border-subtle)' }}
            >
              <Skeleton className="h-3 w-28 shrink-0" />
              <Skeleton className="h-[34px] w-full" />
            </div>
          ))}
        </SCard>
      ))}
    </div>
  )
}

/**
 * A numeric setting's input. The text is handed to `setField` as typed, so an
 * emptied field stays empty instead of snapping to 0, and a value the backend
 * would refuse is named under the input (and blocks Save) instead of coming
 * back as a 422.
 */
export function NumberSettingInput({
  section,
  field,
  value,
  saved,
  setField,
  suffix,
}: {
  section: SectionKey
  field: string
  value: number | string
  /** The stored value; left as it is, it is not this form's to reject. */
  saved: number
  setField: (section: SectionKey, field: string, value: string | number | boolean) => void
  suffix?: string
}) {
  const errorId = useId()
  const error = value === saved ? null : numberFieldError(section, field, value)
  return (
    <>
      <TextInput
        type="number"
        value={String(value)}
        onChange={next => setField(section, field, next)}
        suffix={suffix}
        mono
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
      />
      {error && (
        <p id={errorId} className="mt-1 text-caption" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </>
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
 *
 * `overrides` is what makes that count honest: it is the number of fields the
 * badges above are calling "Override" right now, not the number of fields a
 * reset is able to null.
 */
export function ResetSectionCard({
  section,
  overrides,
  onReset,
  resetting,
}: {
  section: SectionKey
  /** Fields in this section currently badged "Override" (see overrideCount). */
  overrides: number
  onReset: () => void
  resetting: boolean
}) {
  const label = SECTION_LABELS[section]
  const nothingToClear = overrides === 0
  return (
    <SCard
      // Danger tone only when there is something to destroy. On a fresh
      // instance this card sat red, with a live button, at the bottom of all six
      // pages to offer a no-op — which teaches people to ignore the one colour
      // the UI keeps for real consequences (tripl-5qp9).
      tone={nothingToClear ? undefined : 'danger'}
      title={`Reset ${label} to defaults`}
      description={resetCardDescription(section, overrides)}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={resetting || nothingToClear}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to defaults
          </Button>
          {!nothingToClear && (
            <span className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
              Applies immediately — it does not wait for Save changes.
            </span>
          )}
        </>
      }
    />
  )
}
