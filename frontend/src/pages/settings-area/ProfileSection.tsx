import { useAuth } from '@/components/auth-context'
import { Chip } from '@/components/primitives/chip'
import { Field, SCard, SHeader } from '@/components/settings/kit'
import { ROLE_OPTIONS } from '@/types'
import { ComingLaterCard } from './ComingLaterCard'

/**
 * Timestamps render in *your browser's* timezone, so that is what this page
 * shows. It used to render a hardcoded "Europe/Berlin" from a five-city list,
 * which a reader in Tokyo could only read as their account being set wrong
 * (tripl-hmlx).
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

const UNBUILT = [
  { title: 'Avatar and name', detail: 'uploading a picture and editing the name set when the account was created.' },
  {
    title: 'Display preferences',
    detail: 'date format and start of week. Timestamps are relative, in your browser’s timezone, for everyone.',
  },
  {
    title: 'Personal notifications',
    detail:
      'incident alerts and review requests addressed to you. Alerts and digests go to a project’s destinations under Alerting, so there is no per-person switch to offer yet.',
  },
] as const

/**
 * Account · Profile: what the account really holds — name, email, role — and
 * one card for what is not built (WS-37).
 *
 * The preference and notification controls have no backend and nothing reads
 * them. They were first six live controls that persisted nowhere (tripl-z9ot),
 * then the same controls disabled: honest, but a page of controls that do
 * nothing. "Weekly digest" could never have been a per-person switch at all —
 * the digest is fanned out per project alert destination.
 */
export default function ProfileSection() {
  const { user } = useAuth()
  const initials = initialsFrom(user?.name ?? user?.email ?? '')
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === user?.role)?.label ?? user?.role ?? '—'

  return (
    <div>
      <SHeader title="Profile" description="Your personal details across every project you belong to." />

      <SCard title="Your details">
        <Field label="Name" hint="Set when the account was created." htmlFor={false}>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white"
              style={{ background: 'oklch(0.62 0.13 240)' }}
            >
              {initials}
            </span>
            <span className="text-[13px]">{user?.name || '—'}</span>
          </div>
        </Field>
        <Field label="Email" hint="Used for sign-in and notifications." htmlFor={false}>
          <span className="mono text-[13px]">{user?.email ?? '—'}</span>
        </Field>
        <Field label="Role" hint="Set by a workspace owner." htmlFor={false}>
          <Chip tone="accent" size="md">
            {roleLabel}
          </Chip>
        </Field>
        <Field label="Timezone" hint="Read from this browser; timestamps follow it." last htmlFor={false}>
          <span className="mono text-[13px]">{browserTimezone()}</span>
        </Field>
      </SCard>

      <ComingLaterCard items={UNBUILT} />
    </div>
  )
}
