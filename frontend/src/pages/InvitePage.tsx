import { PageHeader } from '@/components/primitives/page-header'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'

import { invitationsApi } from '@/api/invitations'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ROLE_OPTIONS, type AuthUser } from '@/types'
import { getErrorMessage } from '@/lib/utils'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { PASSWORD_MIN_LENGTH, PASSWORD_POLICY_HINT } from '@/lib/passwordPolicy'
import { invitationPreviewKey } from '@/lib/queryKeys'
import { AUTH_QUERY_KEY } from '@/components/auth-context'

/**
 * Redeem an invitation into an account.
 *
 * Reachable without a session by design — the whole point is that this person
 * cannot sign in yet. The address and role come from the invitation, so this
 * form only ever asks for a password and a display name; there is no field that
 * could redirect the invite to a different identity.
 *
 * Unknown, expired and already-used links are indistinguishable here because
 * the API answers all three identically, and this screen must not undo that by
 * guessing at a friendlier explanation.
 */
export default function InvitePage() {
  const { token = '' } = useParams<{ token: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const previewQuery = useQuery({
    meta: SILENT_ERROR_META,
    queryKey: invitationPreviewKey(token),
    queryFn: () => invitationsApi.preview(token),
    retry: false,
  })

  const acceptMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () => invitationsApi.accept(token, password, name.trim() || undefined),
    onSuccess: (user: AuthUser) => {
      // The API already set the session cookie and answered with the account.
      // Writing it straight into the session query is what lands the user in
      // the app: a refetch left the session "anonymous" until /auth/me came
      // back, long enough for the sign-in screen to flash (SHELL-17).
      queryClient.setQueryData<AuthUser | null>(AUTH_QUERY_KEY, user)
      void navigate('/', { replace: true })
    },
  })

  const preview = previewQuery.data

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <div
        className="space-y-4 rounded-xl border p-6"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <PageHeader title="Join this tripl workspace" />

        {previewQuery.isLoading && (
          <p className="text-sm" style={{ color: 'var(--fg-subtle)' }}>
            Checking your invitation…
          </p>
        )}

        {previewQuery.isError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {getErrorMessage(previewQuery.error)}
            </p>
            <p className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
              Ask whoever invited you to send a new link.
            </p>
            <Button type="button" variant="link" size="xs" className="px-0" onClick={() => void navigate('/auth')}>
              Go to sign in
            </Button>
          </div>
        )}

        {preview && (
          <>
            <p className="text-sm" style={{ color: 'var(--fg-subtle)' }}>
              You were invited as <strong>{preview.email}</strong>, joining as{' '}
              <strong>
                {ROLE_OPTIONS.find((r) => r.value === preview.role)?.label ?? preview.role}
              </strong>
              . Set a password to finish.
            </p>

            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (password) acceptMut.mutate()
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="invite-name">Your name (optional)</Label>
                <Input
                  id="invite-name"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-password">Password</Label>
                {/* The policy up front, as on sign-up, rather than learned from
                    a 422 after submitting. */}
                <Input
                  id="invite-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={PASSWORD_MIN_LENGTH}
                  aria-describedby="invite-password-hint"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p id="invite-password-hint" className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
                  {PASSWORD_POLICY_HINT}
                </p>
              </div>

              {acceptMut.isError && (
                <p role="alert" className="text-xs text-destructive">
                  {getErrorMessage(acceptMut.error)}
                </p>
              )}

              <Button type="submit" className="w-full" disabled={acceptMut.isPending || !password}>
                {acceptMut.isPending ? 'Creating your account…' : 'Accept invitation'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
