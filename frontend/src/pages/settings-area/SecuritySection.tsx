import { useMutation } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { authApi } from '@/api/auth'
import { useAuth } from '@/components/auth-context'
import { SCard, SHeader } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { getErrorMessage } from '@/lib/utils'
import { ComingLaterCard } from './ComingLaterCard'

const UNBUILT = [
  {
    title: 'Changing your password here',
    detail: 'with your current one, without the email round trip.',
  },
  {
    title: 'Two-factor authentication',
    detail: 'a code from an authenticator app at sign-in, and single-use recovery codes.',
  },
  {
    title: 'Signed-in devices',
    detail: 'a list of where the account is signed in, and signing out the others. tripl keeps no per-device record yet.',
  },
] as const

/**
 * Account · Security.
 *
 * There is no signed-in change-password endpoint, but the email reset flow
 * exists and works, so the password card runs it for the signed-in address in
 * one click instead of telling the reader to sign out and find "Forgot your
 * password?" (WS-37). It used to hold two inputs and an "Update password"
 * button that did nothing at all, so people walked away believing their
 * password had rotated (tripl-2o74), and then the same controls disabled.
 *
 * Two-factor and session management are not built; they share one "Coming
 * later" card instead of a page of switches nobody can move (tripl-91j6).
 */
export default function SecuritySection() {
  const { user } = useAuth()
  const email = user?.email ?? ''
  const resetMut = useMutation({
    // The outcome renders under the button.
    meta: SILENT_ERROR_META,
    mutationFn: () => authApi.requestPasswordReset({ email }),
  })

  return (
    <div>
      <SHeader title="Security" description="Protect your account." />

      <SCard
        title="Password"
        description="Get a reset link by email and choose a new password from it. Your current password keeps working until you do."
      >
        <div className="flex flex-col gap-2 px-[18px] py-[14px]">
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={!email || resetMut.isPending}
              onClick={() => resetMut.mutate()}
            >
              <Mail className="h-3 w-3" />
              {resetMut.isPending ? 'Sending…' : 'Email me a reset link'}
            </Button>
          </div>
          <div aria-live="polite" className="text-[12px] leading-[1.45]">
            {resetMut.isSuccess &&
              (resetMut.data.email_configured ? (
                <span style={{ color: 'var(--success)' }}>
                  Sent — check {email} for a link to choose a new password.
                </span>
              ) : (
                <span style={{ color: 'var(--warning)' }}>
                  This instance cannot send email, so no link went out. Ask a workspace owner to
                  set up email under Service settings, or to reset the password for you.
                </span>
              ))}
          </div>
          {resetMut.isError && (
            <p role="alert" className="m-0 text-[12px]" style={{ color: 'var(--danger)' }}>
              Could not request a reset link: {getErrorMessage(resetMut.error)}
            </p>
          )}
        </div>
      </SCard>

      <ComingLaterCard items={UNBUILT} />
    </div>
  )
}
