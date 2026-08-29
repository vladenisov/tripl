import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { invitationsApi, type Invitation, type InvitationCreated } from '@/api/invitations'
import { usersApi } from '@/api/users'
import { useAuth } from '@/components/auth-context'
import { ErrorState } from '@/components/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useConfirm } from '@/hooks/useConfirm'
import { Select } from '@/components/settings/kit'
import { ROLE_OPTIONS, type Role, type UserListItem } from '@/types'
import { formatIsoDate } from '@/lib/datetime'
import { getErrorMessage } from '@/lib/utils'

function roleChip(role: Role) {
  return ROLE_OPTIONS.find((r) => r.value === role)?.chip ?? 'bg-muted text-muted-foreground'
}

function initialsOf(u: UserListItem): string {
  const base = (u.name ?? u.email).trim()
  if (base.includes(' ')) {
    return base
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('')
  }
  return base.slice(0, 2).toUpperCase()
}

/**
 * Invite one person without opening the instance to the world.
 *
 * The redeem link is shown exactly once, right after minting: the server never
 * returns it again, so this is the only chance to copy it. That is deliberate —
 * SMTP is optional here, so handing the link over out of band is a first-class
 * path rather than a fallback.
 */
function InviteMemberCard() {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [minted, setMinted] = useState<InvitationCreated | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const linkRef = useRef<HTMLInputElement>(null)
  const { confirm, dialog } = useConfirm()

  const invitesQuery = useQuery({
    queryKey: ['invitations'],
    queryFn: () => invitationsApi.list(),
  })
  const createMut = useMutation({
    mutationFn: () => invitationsApi.create(email.trim(), role),
    onSuccess: (created) => {
      setMinted(created)
      setCopyState('idle')
      setEmail('')
      qc.invalidateQueries({ queryKey: ['invitations'] })
    },
  })
  const revokeMut = useMutation({
    mutationFn: (id: string) => invitationsApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations'] }),
  })

  const handleRevoke = async (inv: Invitation) => {
    const ok = await confirm({
      title: 'Revoke invitation',
      message:
        `Revoke the invitation for ${inv.email}? Their link stops working immediately, and `
        + 'it cannot be reissued — you would have to create a new invite and send the new link.',
      confirmLabel: 'Revoke',
      variant: 'danger',
    })
    if (ok) revokeMut.mutate(inv.id)
  }

  const invites = invitesQuery.data ?? []
  const acceptUrl = minted ? `${window.location.origin}${minted.accept_path}` : ''

  return (
    <div
      className="space-y-3 rounded-xl border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {dialog}

      <div>
        <h3 className="text-[13px] font-semibold">Invite a member</h3>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--fg-subtle)' }}>
          Creates a single-use link for one address, at the role you pick. Use this instead of
          opening self-service registration.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (email.trim()) createMut.mutate()
        }}
      >
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-[11px]" htmlFor="invite-email">
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="h-8 w-full rounded-md border px-2 text-xs"
            style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
          />
        </div>
        {/* The kit's Select, not a bare one. A native <select> keeps the
            platform's own widget: Chrome paints it with the UA's light
            background whatever `background` we hand it, so this was a pale box
            with a black chevron sitting beside a dark custom email input — the
            only unthemed control on the page (tripl-h3bb). The kit turns
            `appearance` off, sets the foreground colour and draws its own
            chevron, which is why every other select in the settings area looks
            like it belongs. */}
        <div className="w-32">
          <label className="mb-1 block text-[11px]" htmlFor="invite-role">
            Role
          </label>
          <Select
            id="invite-role"
            value={role}
            onChange={(next) => setRole(next as Role)}
            options={ROLE_OPTIONS}
          />
        </div>
        <button
          type="submit"
          disabled={createMut.isPending || !email.trim()}
          className="h-8 rounded-md border px-3 text-xs font-medium disabled:opacity-50"
          style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}
        >
          {createMut.isPending ? 'Creating…' : 'Create invite link'}
        </button>
      </form>

      {createMut.isError && (
        <p role="alert" className="text-xs text-destructive">
          {getErrorMessage(createMut.error)}
        </p>
      )}

      {minted && (
        <div
          className="space-y-1.5 rounded-lg border p-3"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}
        >
          <p className="text-xs font-medium">
            Invite link for {minted.invitation.email} — copy it now
          </p>
          <p className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            This link is shown once and cannot be retrieved later. It expires{' '}
            {formatIsoDate(minted.expires_at)} and works a single time.
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={linkRef}
              readOnly
              aria-label="Invite link"
              value={acceptUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="mono h-8 flex-1 rounded-md border px-2 text-[11px]"
              style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
            />
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  try {
                    if (!navigator.clipboard) throw new Error('clipboard unavailable')
                    await navigator.clipboard.writeText(acceptUrl)
                    setCopyState('copied')
                  } catch {
                    // No clipboard (a self-hosted instance on plain HTTP has none)
                    // or the write was refused. This link is shown exactly once,
                    // so claiming a copy that did not happen loses it outright.
                    linkRef.current?.select()
                    setCopyState('failed')
                  }
                })()
              }}
              className="h-8 shrink-0 rounded-md border px-3 text-xs"
              style={{ borderColor: 'var(--border)' }}
            >
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </button>
          </div>
          {copyState === 'failed' && (
            <p role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>
              Couldn’t reach the clipboard. The link above is selected — press Ctrl/⌘+C to copy it.
            </p>
          )}
        </div>
      )}

      {invitesQuery.isError && (
        <ErrorState
          compact
          title="Couldn't load pending invitations"
          error={invitesQuery.error}
          onRetry={() => {
            void invitesQuery.refetch()
          }}
        />
      )}

      {invites.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium" style={{ color: 'var(--fg-subtle)' }}>
            Pending invitations
          </p>
          {invites.map((inv: Invitation) => (
            <div
              key={inv.id}
              className="flex items-center gap-2 border-b py-1.5 last:border-0"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="mono min-w-0 flex-1 truncate text-[11px]">{inv.email}</span>
              <span className="text-[10px]" style={{ color: 'var(--fg-faint)' }}>
                {ROLE_OPTIONS.find((r) => r.value === inv.role)?.label ?? inv.role}
              </span>
              <span
                className="text-[10px]"
                style={{ color: inv.is_expired ? 'var(--danger)' : 'var(--fg-faint)' }}
              >
                {inv.is_expired ? 'expired' : `expires ${formatIsoDate(inv.expires_at)}`}
              </span>
              <button
                type="button"
                onClick={() => {
                  void handleRevoke(inv)
                }}
                disabled={revokeMut.isPending && revokeMut.variables === inv.id}
                className="h-6 shrink-0 rounded border px-2 text-[10px]"
                style={{ borderColor: 'var(--border)' }}
              >
                {revokeMut.isPending && revokeMut.variables === inv.id ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}

      {revokeMut.isError && (
        <p role="alert" className="text-xs text-destructive">
          {getErrorMessage(revokeMut.error)}
        </p>
      )}
    </div>
  )
}

export default function UsersPage() {
  const qc = useQueryClient()
  const { user: currentUser } = useAuth()
  const isOwner = currentUser?.role === 'owner'

  const listQuery = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() })
  const updateMut = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      usersApi.updateRole(userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })
  const users = listQuery.data ?? []

  return (
    <div className="space-y-5">
      {/* The section header above this (MembersSection) already says who is in
          the list. This used to restate it in a second vocabulary — "workspace"
          there, "instance" here — so two subtitles stacked directly on top of
          each other and a reader had to work out whether they named two
          different scopes (tripl-h3bb). All that is left is the one fact the
          header does not carry, and only for the people it applies to. */}
      {!isOwner && (
        <p className="text-sm" style={{ color: 'var(--fg-subtle)' }}>
          Only owners can change roles.
        </p>
      )}

      {isOwner && <InviteMemberCard />}

      <div
        className="overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {listQuery.isLoading ? (
          <div aria-busy="true" aria-label="Loading users">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2.5 w-48" />
                </div>
                <Skeleton className="h-5 w-20 shrink-0" />
              </div>
            ))}
          </div>
        ) : listQuery.isError ? (
          /* Before the error branch existed, a failed fetch fell through to
             "No users yet." — a page that always contains at least the reader,
             claiming to be empty, with nowhere to retry. */
          <div className="p-4">
            <ErrorState
              compact
              title="Couldn't load users"
              error={listQuery.error}
              onRetry={() => {
                void listQuery.refetch()
              }}
            />
          </div>
        ) : users.length === 0 ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--fg-subtle)' }}>
            No users yet.
          </div>
        ) : (
          users.map((u: UserListItem) => (
            <div
              key={u.id}
              className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              {/* One avatar colour, the same token the shell and the settings
                  sidebar use. The hue used to be hashed from the user id, so
                  the person reading this page saw their own initials in pink
                  here and in blue in the sidebar footer 30px away — one account
                  rendered as two (tripl-h3bb). A hue carries no meaning worth
                  that. */}
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ background: 'var(--avatar-bg)' }}
              >
                {initialsOf(u)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium leading-tight">
                  {u.name ?? u.email}
                </div>
                <div
                  className="mono truncate text-[11px] leading-tight"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  {u.email}
                </div>
              </div>
              {/* The bare "2026-08-19" was a date with no question attached —
                  joined? invited? last seen? — in a table that has no column
                  headers to answer it (tripl-h3bb). The format stays ISO: this
                  roster is read by whoever administers the instance, from
                  wherever they are, and formatIsoDate is the locale-proof one. */}
              <span
                className="hidden w-36 shrink-0 text-right text-[11px] sm:block"
                style={{ color: 'var(--fg-faint)' }}
              >
                Joined <span className="mono">{formatIsoDate(u.created_at)}</span>
              </span>
              <div className="w-32 shrink-0 text-right">
                {isOwner && u.id !== currentUser?.id ? (
                  <Select
                    value={u.role}
                    aria-label={`Role for ${u.name ?? u.email}`}
                    onChange={(next) => updateMut.mutate({ userId: u.id, role: next as Role })}
                    disabled={updateMut.isPending}
                    options={ROLE_OPTIONS}
                  />
                ) : (
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${roleChip(u.role)}`}
                  >
                    {ROLE_OPTIONS.find((r) => r.value === u.role)?.label ?? u.role}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
        {updateMut.isError && (
          <p role="alert" className="px-4 py-3 text-xs text-destructive">{getErrorMessage(updateMut.error)}</p>
        )}
      </div>
    </div>
  )
}
