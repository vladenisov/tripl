import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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
