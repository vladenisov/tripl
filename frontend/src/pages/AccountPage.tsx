import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Key, Plus, Trash2 } from 'lucide-react'

import { apiKeysApi } from '@/api/apiKeys'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useConfirm } from '@/hooks/useConfirm'
import type { ApiKey, ApiKeyScope, ApiKeyWithToken } from '@/types'
import { getErrorMessage } from '@/lib/utils'

function scopeChip(scope: ApiKeyScope): string {
  return scope === 'write'
    ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
}

export default function AccountPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const { confirm, dialog } = useConfirm()

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<ApiKeyScope>('read')
  const [projectSlug, setProjectSlug] = useState<string>('')
  const [expiresInDays, setExpiresInDays] = useState<string>('')
  const [revealed, setRevealed] = useState<ApiKeyWithToken | null>(null)

  const listQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => apiKeysApi.list(),
  })

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => projectsApi.list(),
  })

  // Map a key's bound project_id back to a human name for the list. Falls back
  // to the id if the project was deleted out from under the key.
  const projectNameById = (projectsQuery.data ?? []).reduce<Record<string, string>>(
    (acc, p) => {
      acc[p.id] = p.name
      return acc
    },
    {},
  )

  const createMut = useMutation({
    mutationFn: () =>
      apiKeysApi.create({
        name: name.trim(),
        scope,
        expires_in_days: expiresInDays ? Number(expiresInDays) : null,
        project_slug: projectSlug || null,
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      setShowForm(false)
      setRevealed(created)
      setName('')
      setScope('read')
      setProjectSlug('')
      setExpiresInDays('')
    },
  })

  const revokeMut = useMutation({
    mutationFn: (keyId: string) => apiKeysApi.revoke(keyId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  const handleRevoke = async (key: ApiKey) => {
    const ok = await confirm({
      title: 'Revoke API key',
      message: `Revoke "${key.name}"? Any agent or script using this key will start receiving 401s immediately.`,
      confirmLabel: 'Revoke',
      variant: 'danger',
    })
    if (ok) revokeMut.mutate(key.id)
  }

  const keys = listQuery.data ?? []

  return (
    <div className="space-y-5">
      {dialog}

      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Key className="h-5 w-5" />
          Account
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Signed in as <span className="font-mono">{user?.email}</span>
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold">API keys</h2>
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4 mr-1" /> New key
          </Button>
        </div>
        <p className="text-sm text-muted-foreground mb-3">
          Long-lived bearer tokens for non-browser clients (LLM agents, CLI scripts).
          Send them as <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>.
          Read keys can only call <span className="font-mono">GET</span> endpoints;
          write keys carry your editor permissions.
        </p>

        <Card>
          <CardContent className="p-0">
            {listQuery.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : keys.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No API keys yet. Generate one to give an agent access.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-24">Scope</TableHead>
                    <TableHead className="w-40">Project</TableHead>
                    <TableHead className="w-40">Prefix</TableHead>
                    <TableHead className="w-32">Last used</TableHead>
                    <TableHead className="w-32">Created</TableHead>
                    <TableHead className="w-32">Expires</TableHead>
                    <TableHead className="w-16"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {keys.map((k: ApiKey) => {
                    const expired = k.expires_at && new Date(k.expires_at) < new Date()
                    const revoked = k.revoked_at != null
                    return (
                      <TableRow key={k.id} className={revoked || expired ? 'opacity-60' : ''}>
                        <TableCell className="font-medium">{k.name}</TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded px-2 py-0.5 text-[10px] font-medium ${scopeChip(
                              k.scope,
                            )}`}
                          >
                            {k.scope}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs">
                          {k.project_id ? (
                            projectNameById[k.project_id] ?? k.project_id
                          ) : (
                            <span className="text-muted-foreground">All projects</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{k.key_prefix}…</TableCell>
                        <TableCell className="text-xs tnum text-muted-foreground">
                          {k.last_used_at
                            ? new Date(k.last_used_at).toLocaleString()
                            : '—'}
                        </TableCell>
                        <TableCell className="text-xs tnum text-muted-foreground">
                          {new Date(k.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-xs tnum text-muted-foreground">
                          {revoked ? (
                            <Badge variant="destructive" className="text-[10px]">revoked</Badge>
                          ) : expired ? (
                            <Badge variant="destructive" className="text-[10px]">expired</Badge>
                          ) : k.expires_at ? (
                            new Date(k.expires_at).toLocaleDateString()
                          ) : (
                            'never'
                          )}
                        </TableCell>
                        <TableCell>
                          {!revoked && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() => handleRevoke(k)}
                              disabled={revokeMut.isPending}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              createMut.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>New API key</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. claude-agent"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label>Scope</Label>
                <select
                  value={scope}
                  onChange={(e) => setScope(e.target.value as ApiKeyScope)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="read">read — GET endpoints only</option>
                  <option value="write">write — full editor access</option>
                </select>
              </div>
              <div className="grid gap-2">
                <Label>Project (optional)</Label>
                <select
                  value={projectSlug}
                  onChange={(e) => setProjectSlug(e.target.value)}
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                >
                  <option value="">All projects — full account reach</option>
                  {(projectsQuery.data ?? []).map((p) => (
                    <option key={p.id} value={p.slug}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Bind the key to one project to fence an agent in — it then only
                  reaches that project's endpoints.
                </p>
              </div>
              <div className="grid gap-2">
                <Label>Expires in (days, optional)</Label>
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value)}
                  placeholder="leave blank for no expiration"
                />
              </div>
              {createMut.isError && (
                <p className="text-xs text-destructive">
                  {getErrorMessage(createMut.error)}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending || !name.trim()}>
                Generate
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* One-time token reveal */}
      <Dialog open={revealed != null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key now</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <p className="text-sm text-muted-foreground">
              This token is shown only once. Copy it now and store it somewhere safe — you
              won't be able to see it again.
            </p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <code className="flex-1 break-all font-mono text-xs">{revealed?.token}</code>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => {
                  if (revealed) navigator.clipboard.writeText(revealed.token)
                }}
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
