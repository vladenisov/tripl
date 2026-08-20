import { LogOut, RefreshCw } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import { Field, SCard, SHeader, TextInput, Toggle } from '@/components/settings/kit'
import { PASSWORD_POLICY_HINT } from '@/lib/passwordPolicy'

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
        description="You can't change your password here yet. Sign out, then use “Forgot your password?” on the sign-in screen to get a reset link by email."
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

      {/* The row hint used to read "Strongly recommended for owners." directly
          under "Not available yet": the card urged an action beside a switch
          nobody can move (tripl-91j6). It now describes what the control would
          do and leaves the recommending to a release that can honour it. */}
      <SCard
        title="Two-factor authentication"
        description="Not available yet on this instance — neither control below can be turned on."
      >
        <div className="flex items-center gap-[18px] px-[18px] py-[14px]" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Authenticator app</div>
            <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
              A time-based code at sign-in, on top of the password.
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

      {/* This used to iterate a one-element SESSIONS constant whose row read
          "Current location · —": a label where a value belongs and an em dash
          for an IP, printed under "review where it's signed in" as if it were a
          device audit (tripl-91j6). tripl keeps no per-device record, so the
          card states only what it can know — that you are reading it in this
          browser — and the footer no longer promises to keep this device
          beside a button offering to sign out of all of them. */}
      <SCard
        title="Active sessions"
        description="Only this browser can be listed — tripl keeps no per-device record, so there is nothing else here to audit or revoke."
        footer={
          <>
            <span className="flex-1 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Signing out other devices would leave this one signed in.
            </span>
            <Button variant="outline" size="sm" disabled>
              <LogOut className="h-3 w-3" />
              Sign out other devices
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-3 px-[18px] py-[13px]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-[7px] text-[13px] font-medium">
              This browser
              <Chip tone="success" size="xs">
                This device
              </Chip>
            </div>
            <div className="mt-px text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
              The session you are reading this in.
            </div>
          </div>
          <span className="text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
            Active now
          </span>
        </div>
      </SCard>
    </div>
  )
}
