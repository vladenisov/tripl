import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { invitationsApi, type Invitation, type InvitationCreated } from '@/api/invitations'
import { usersApi } from '@/api/users'
import { useAuth } from '@/components/auth-context'
import { ROLE_OPTIONS, type Role, type UserListItem } from '@/types'
import { formatIsoDate } from '@/lib/datetime'
import { getErrorMessage } from '@/lib/utils'

function roleChip(role: Role) {
  return ROLE_OPTIONS.find((r) => r.value === role)?.chip ?? 'bg-muted text-muted-foreground'
}

// Deterministic avatar hue from a stable key so each member reads distinctly,
// matching the mockup's hued member avatars.
function avatarHue(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360
  return h
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
  const [copied, setCopied] = useState(false)

  const invitesQuery = useQuery({
    queryKey: ['invitations'],
    queryFn: () => invitationsApi.list(),
  })
  const createMut = useMutation({
    mutationFn: () => invitationsApi.create(email.trim(), role),
    onSuccess: (created) => {
      setMinted(created)
      setCopied(false)
      setEmail('')
      qc.invalidateQueries({ queryKey: ['invitations'] })
    },
  })
  const revokeMut = useMutation({
    mutationFn: (id: string) => invitationsApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invitations'] }),
  })

  const invites = invitesQuery.data ?? []
  const acceptUrl = minted ? `${window.location.origin}${minted.accept_path}` : ''

  return (
    <div
      className="space-y-3 rounded-xl border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
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
        <div>
          <label className="mb-1 block text-[11px]" htmlFor="invite-role">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="h-8 rounded-md border px-2 text-xs"
            style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
          >
            {ROLE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
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
                void navigator.clipboard?.writeText(acceptUrl)
                setCopied(true)
              }}
              className="h-8 shrink-0 rounded-md border px-3 text-xs"
              style={{ borderColor: 'var(--border)' }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
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
                onClick={() => revokeMut.mutate(inv.id)}
                disabled={revokeMut.isPending}
                className="h-6 shrink-0 rounded border px-2 text-[10px]"
                style={{ borderColor: 'var(--border)' }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
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
      <p className="text-sm" style={{ color: 'var(--fg-subtle)' }}>
        {isOwner
          ? 'Manage roles for everyone with access to this tripl instance.'
          : 'Roster of users with access to this tripl instance. Only owners can change roles.'}
      </p>

      {isOwner && <InviteMemberCard />}

      <div
        className="overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {listQuery.isLoading ? (
          <div className="px-4 py-6 text-sm" style={{ color: 'var(--fg-subtle)' }}>
            Loading…
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
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                style={{ background: `oklch(0.62 0.13 ${avatarHue(u.id || u.email)})` }}
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
              <span
                className="mono hidden w-28 shrink-0 text-right text-[11px] sm:block"
                style={{ color: 'var(--fg-faint)' }}
              >
                {formatIsoDate(u.created_at)}
              </span>
              <div className="w-32 shrink-0 text-right">
                {isOwner && u.id !== currentUser?.id ? (
                  <select
                    value={u.role}
                    aria-label={`Role for ${u.name ?? u.email}`}
                    onChange={(e) => updateMut.mutate({ userId: u.id, role: e.target.value as Role })}
                    disabled={updateMut.isPending}
                    className="h-7 w-full rounded-md border px-2 text-xs"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
                  >
                    {ROLE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
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
