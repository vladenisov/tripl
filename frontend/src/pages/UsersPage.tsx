import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'

import { usersApi } from '@/api/users'
import { useAuth } from '@/components/auth-context'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ROLE_OPTIONS, type Role, type UserListItem } from '@/types'

function roleChip(role: Role) {
  return ROLE_OPTIONS.find((r) => r.value === role)?.chip ?? 'bg-muted text-muted-foreground'
}

export default function UsersPage() {
  const qc = useQueryClient()
  const { user: currentUser } = useAuth()
  const isOwner = currentUser?.role === 'owner'

  const listQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
  })

  const updateMut = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      usersApi.updateRole(userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const users = listQuery.data ?? []

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Users className="h-5 w-5" />
          Users
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isOwner
            ? 'Manage roles for everyone with access to this tripl instance.'
            : 'Roster of users with access to this tripl instance. Only owners can change roles.'}
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          {listQuery.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : users.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No users yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="w-32">Role</TableHead>
                  <TableHead className="w-40">Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u: UserListItem) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs">{u.email}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.name ?? '—'}</TableCell>
                    <TableCell>
                      {isOwner && u.id !== currentUser?.id ? (
                        <select
                          value={u.role}
                          onChange={(e) =>
                            updateMut.mutate({ userId: u.id, role: e.target.value as Role })
                          }
                          disabled={updateMut.isPending}
                          className="flex h-7 w-full rounded-md border border-input bg-background px-2 py-0.5 text-xs"
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      ) : (
                        <span className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${roleChip(u.role)}`}>
                          {ROLE_OPTIONS.find((r) => r.value === u.role)?.label ?? u.role}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tnum text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {updateMut.isError && (
            <p className="p-3 text-xs text-destructive">
              {(updateMut.error as Error).message}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
