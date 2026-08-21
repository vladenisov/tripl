import { Upload } from 'lucide-react'
import { useAuth } from '@/components/auth-context'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import { Field, SCard, Select, SHeader, TextInput, ToggleRow } from '@/components/settings/kit'
import { ROLE_OPTIONS } from '@/types'

const DATE_FORMATS = [
  { value: 'rel', label: 'Relative (2h ago)' },
  { value: 'iso', label: 'ISO (2026-06-15)' },
  { value: 'us', label: 'US (Jun 15, 2026)' },
]
const WEEK_START = [
  { value: 'mon', label: 'Monday' },
  { value: 'sun', label: 'Sunday' },
]

/**
 * The Preferences card promises timestamps in *your browser's* timezone, so the
 * control under that sentence has to show the same thing. It used to render a
 * hardcoded "Europe/Berlin" from a five-city list, which a reader in Tokyo
 * could only read as their account being set wrong — two adjacent lines giving
 * two answers to "what timezone are my timestamps in" (tripl-hmlx).
 */
function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function initialsFrom(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '•'
  if (trimmed.includes(' ')) {
    return trimmed
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('')
  }
  return trimmed.slice(0, 2).toUpperCase()
}

/**
 * Account · Profile. Email and role read from the real authenticated user.
 *
 * The preference and notification controls have no backend and nothing reads
 * them, so they are rendered disabled and labelled as unavailable rather than
 * accepting input. They used to be six live useState controls under a card
 * that promised "saved on this device": a user set Date format to ISO, came
 * back, and it was gone (tripl-z9ot). "Weekly digest" was the worst of them —
 * the digest is a real Celery beat job fanned out per project alert
 * destination, so a per-person switch could never have gated it.
 */
export default function ProfileSection() {
  const { user } = useAuth()
  const initials = initialsFrom(user?.name ?? user?.email ?? '')
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === user?.role)?.label ?? user?.role ?? '—'
  const timezone = browserTimezone()

  return (
    <div>
      <SHeader title="Profile" description="Your personal details across every project you belong to." />

      <SCard title="Your details">
        {/* Two buttons and an initials bubble — nothing a <label> can name. */}
        <Field label="Avatar" hint="PNG or JPG, at least 256×256." htmlFor={false}>
          <div className="flex items-center gap-3">
            <span
              className="flex h-12 w-12 items-center justify-center rounded-full text-base font-semibold text-white"
              style={{ background: 'oklch(0.62 0.13 240)' }}
            >
              {initials}
            </span>
            <Button variant="outline" size="sm" disabled>
              <Upload className="h-3 w-3" />
              Upload
            </Button>
            <Button variant="ghost" size="sm" disabled>
              Remove
            </Button>
          </div>
        </Field>
        <Field label="Full name" hint="Set when the account was created; editing it isn't available yet.">
          <TextInput value={user?.name ?? ''} disabled />
        </Field>
        <Field label="Email" hint="Used for sign-in and notifications.">
          <TextInput value={user?.email ?? ''} mono disabled />
        </Field>
        <Field label="Role" hint="Set by a workspace owner." last htmlFor={false}>
          <Chip tone="accent" size="md">
            {roleLabel}
          </Chip>
        </Field>
      </SCard>

      <SCard
        title="Preferences"
        description="Not available yet — tripl shows relative timestamps in your browser's timezone for everyone."
      >
        <Field label="Timezone" hint="Read from this browser, not stored on the account.">
          <Select value={timezone} options={[timezone]} disabled />
        </Field>
        <Field label="Date format">
          <Select value="rel" options={DATE_FORMATS} disabled />
        </Field>
        <Field label="Start of week" last>
          <Select value="mon" options={WEEK_START} disabled />
        </Field>
      </SCard>

      <SCard
        title="Notifications"
        description="Not available yet — tripl has no per-person delivery settings. Alerts and digests are addressed to a project's destinations under Alerting."
      >
        <ToggleRow
          label="Incident alerts"
          hint="Spikes, drops and firing monitors on events you own."
          value={false}
          disabled
        />
        <ToggleRow
          label="Review requests"
          hint="When you're asked to approve a plan change."
          value={false}
          disabled
        />
        <ToggleRow
          label="Weekly digest"
          hint="Delivered per project alert destination, not per person, so this switch could not stop it."
          value={false}
          disabled
          last
        />
      </SCard>
    </div>
  )
}
