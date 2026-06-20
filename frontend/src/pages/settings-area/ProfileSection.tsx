import { useState } from 'react'
import { Upload } from 'lucide-react'
import { useAuth } from '@/components/auth-context'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import { Field, SCard, Select, SHeader, TextInput, ToggleRow } from '@/components/settings/kit'
import { ROLE_OPTIONS } from '@/types'

const TIMEZONES = ['Europe/Berlin', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']
const DATE_FORMATS = [
  { value: 'rel', label: 'Relative (2h ago)' },
  { value: 'iso', label: 'ISO (2026-06-15)' },
  { value: 'us', label: 'US (Jun 15, 2026)' },
]
const WEEK_START = [
  { value: 'mon', label: 'Monday' },
  { value: 'sun', label: 'Sunday' },
]

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
 * Account · Profile. Email and role read from the real authenticated user; the
 * remaining preference and notification controls are presentation-only (no
 * backend endpoint yet) and operate on local state so the UI is complete
 * without inventing API calls.
 */
export default function ProfileSection() {
  const { user } = useAuth()
  const initials = initialsFrom(user?.name ?? user?.email ?? '')
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === user?.role)?.label ?? user?.role ?? '—'

  // Local-only preference + notification state (not yet wired to a backend).
  const [timezone, setTimezone] = useState('Europe/Berlin')
  const [dateFormat, setDateFormat] = useState('rel')
  const [weekStart, setWeekStart] = useState('mon')
  const [incidentAlerts, setIncidentAlerts] = useState(true)
  const [reviewRequests, setReviewRequests] = useState(true)
  const [weeklyDigest, setWeeklyDigest] = useState(false)

  return (
    <div>
      <SHeader title="Profile" description="Your personal details across every project you belong to." />

      <SCard title="Your details">
        <Field label="Avatar" hint="PNG or JPG, at least 256×256.">
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
        <Field label="Full name">
          <TextInput value={user?.name ?? ''} disabled />
        </Field>
        <Field label="Email" hint="Used for sign-in and notifications.">
          <TextInput value={user?.email ?? ''} mono disabled />
        </Field>
        <Field label="Role" hint="Set by a workspace owner." last>
          <Chip tone="accent" size="md">
            {roleLabel}
          </Chip>
        </Field>
      </SCard>

      <SCard title="Preferences" description="Display preferences (saved on this device).">
        <Field label="Timezone">
          <Select value={timezone} onChange={setTimezone} options={TIMEZONES} />
        </Field>
        <Field label="Date format">
          <Select value={dateFormat} onChange={setDateFormat} options={DATE_FORMATS} />
        </Field>
        <Field label="Start of week" last>
          <Select value={weekStart} onChange={setWeekStart} options={WEEK_START} />
        </Field>
      </SCard>

      <SCard title="Notifications" description="How tripl reaches you when something needs attention.">
        <ToggleRow
          label="Incident alerts"
          hint="Spikes, drops and firing monitors on events you own."
          value={incidentAlerts}
          onChange={setIncidentAlerts}
        />
        <ToggleRow
          label="Review requests"
          hint="When you're asked to approve a plan change."
          value={reviewRequests}
          onChange={setReviewRequests}
        />
        <ToggleRow
          label="Weekly digest"
          hint="A Monday summary of plan health and coverage."
          value={weeklyDigest}
          onChange={setWeeklyDigest}
          last
        />
      </SCard>
    </div>
  )
}
