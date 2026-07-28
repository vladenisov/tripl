import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'

import { invitationsApi } from '@/api/invitations'
import { useAuth } from '@/components/auth-context'
import { ROLE_OPTIONS } from '@/types'
import { getErrorMessage } from '@/lib/utils'

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
  const { refresh } = useAuth()
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const previewQuery = useQuery({
    queryKey: ['invitationPreview', token],
    queryFn: () => invitationsApi.preview(token),
    retry: false,
  })

  const acceptMut = useMutation({
    mutationFn: () => invitationsApi.accept(token, password, name.trim() || undefined),
    onSuccess: () => {
      // The API already set the session cookie, so pull the new identity into
      // the app rather than bouncing through the sign-in screen.
      refresh()
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
        <h1 className="text-lg font-semibold">Join this tripl workspace</h1>

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
            <button
              type="button"
              onClick={() => void navigate('/auth')}
              className="text-xs underline underline-offset-4"
            >
              Go to sign in
            </button>
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
              <div>
                <label className="mb-1 block text-xs" htmlFor="invite-name">
                  Your name (optional)
                </label>
                <input
                  id="invite-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9 w-full rounded-md border px-2 text-sm"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs" htmlFor="invite-password">
                  Password
                </label>
                <input
                  id="invite-password"
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-9 w-full rounded-md border px-2 text-sm"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
                />
              </div>

              {acceptMut.isError && (
                <p role="alert" className="text-xs text-destructive">
                  {getErrorMessage(acceptMut.error)}
                </p>
              )}

              <button
                type="submit"
                disabled={acceptMut.isPending || !password}
                className="h-9 w-full rounded-md border text-sm font-medium disabled:opacity-50"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
              >
                {acceptMut.isPending ? 'Creating your account…' : 'Accept invitation'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
