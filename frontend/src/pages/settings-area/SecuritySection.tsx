import { LogOut, RefreshCw } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import { Field, SCard, SHeader, TextInput, Toggle } from '@/components/settings/kit'
import { PASSWORD_POLICY_HINT } from '@/lib/passwordPolicy'

type SessionRow = {
  device: string
  loc: string
  ip: string
  last: string
  current?: boolean
}

// Presentation-only session list — there is no per-session backend yet, so this
// mirrors the mockup with representative rows rather than inventing an endpoint.
const SESSIONS: SessionRow[] = [
  { device: 'This browser', loc: 'Current location', ip: '—', last: 'Active now', current: true },
]

/**
 * Account · Security. Signed-in password change, two-factor authentication and
 * active session management are not yet backed by API endpoints, so the
 * controls here are presentation-only (disabled) and clearly framed as such,
 * rather than wiring fabricated requests.
 */
export default function SecuritySection() {
  return (
    <div>
      <SHeader title="Security" description="Protect your account and review where it's signed in." />

      {/* The two inputs and the button used to be live: the button enabled as
          soon as both fields were non-empty and then did nothing at all — no
          request, no error, no toast — so people walked away believing their
          password had rotated (tripl-2o74). There is no authenticated
          change-password endpoint, but the reset flow does exist and works, so
          the card points at that instead of pretending. */}
      <SCard
        title="Password"
        description="Changing your password in-app isn't wired up yet. Sign out and use “Forgot your password?” on the sign-in screen to get a reset link by email."
        footer={
          <>
            <span className="flex-1" />
            <Button size="sm" disabled>
              Update password
            </Button>
          </>
        }
      >
        <Field label="Current password">
          <TextInput value="" type="password" disabled />
        </Field>
        <Field label="New password" hint={PASSWORD_POLICY_HINT} last>
          <TextInput value="" type="password" disabled />
        </Field>
      </SCard>

      <SCard
        title="Two-factor authentication"
        description="Not available yet on this instance."
      >
        <div className="flex items-center gap-[18px] px-[18px] py-[14px]" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Authenticator app</div>
            <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
              Require a time-based code at sign-in. Strongly recommended for owners.
            </div>
          </div>
          <Toggle value={false} disabled aria-label="Authenticator app" />
        </div>
        <div className="flex items-center gap-[18px] px-[18px] py-[14px]">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Recovery codes</div>
            <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
              Single-use codes for when you lose your device.
            </div>
          </div>
          <Button variant="outline" size="sm" disabled>
            <RefreshCw className="h-3 w-3" />
            Regenerate
          </Button>
        </div>
      </SCard>

      <SCard
        title="Active sessions"
        footer={
          <>
            <span className="flex-1 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Signing out everywhere keeps this device.
            </span>
            <Button variant="outline" size="sm" disabled>
              <LogOut className="h-3 w-3" />
              Sign out all
            </Button>
          </>
        }
      >
        {SESSIONS.map((s, i) => (
          <div
            key={s.device}
            className="flex items-center gap-3 px-[18px] py-[13px]"
            style={{ borderBottom: i === SESSIONS.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-[7px] text-[13px] font-medium">
                {s.device}
                {s.current && (
                  <Chip tone="success" size="xs">
                    This device
                  </Chip>
                )}
              </div>
              <div className="mt-px text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                {s.loc} · <span className="mono">{s.ip}</span>
              </div>
            </div>
            <span className="text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
              {s.last}
            </span>
          </div>
        ))}
      </SCard>
    </div>
  )
}
