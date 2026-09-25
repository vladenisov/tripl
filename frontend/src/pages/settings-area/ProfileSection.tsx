import { useAuth } from '@/components/auth-context'
import { Chip } from '@/components/primitives/chip'
import { Field, SCard, SHeader } from '@/components/settings/kit'
import { UserAvatar } from '@/components/ui/user-avatar'
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
  const roleLabel = ROLE_OPTIONS.find((r) => r.value === user?.role)?.label ?? user?.role ?? '—'

  return (
    <div>
      <SHeader title="Profile" description="Your personal details across every project you belong to." />

      <SCard title="Your details">
        <Field label="Name" hint="Set when the account was created." htmlFor={false}>
          <div className="flex items-center gap-3">
            {/* The shared avatar on --avatar-bg, the colour the sidebar shows for
                the same account. A hand-picked lighter blue here fell below AA
                for the white initials and read as a second identity (WS-38). */}
            <UserAvatar name={user?.name || user?.email} size={40} />
            <span className="text-body">{user?.name || '—'}</span>
          </div>
        </Field>
        <Field label="Email" hint="Used for sign-in and notifications." htmlFor={false}>
          <span className="mono text-body">{user?.email ?? '—'}</span>
        </Field>
        <Field label="Role" hint="Set by a workspace owner." htmlFor={false}>
          <Chip tone="accent" size="md">
            {roleLabel}
          </Chip>
        </Field>
        <Field label="Timezone" hint="Read from this browser; timestamps follow it." last htmlFor={false}>
          <span className="mono text-body">{browserTimezone()}</span>
        </Field>
      </SCard>

      <ComingLaterCard items={UNBUILT} />
    </div>
  )
}
