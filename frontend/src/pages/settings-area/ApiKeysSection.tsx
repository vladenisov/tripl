import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Lock, Plus } from 'lucide-react'
import { apiKeysApi } from '@/api/apiKeys'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useConfirm } from '@/hooks/useConfirm'
import { getErrorMessage } from '@/lib/utils'
import { SCard, SHeader } from '@/components/settings/kit'
import type { ApiKey, ApiKeyScope, ApiKeyWithToken } from '@/types'

/**
 * Workspace · API keys. Reuses the real apiKeysApi wiring (the same create /
 * reveal-once / revoke flow as AccountPage) rendered in the takeover idiom: a
 * "shown once" warning banner plus a card of active keys with scope chips.
 */
export default function ApiKeysSection() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const { confirm, dialog } = useConfirm()

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<ApiKeyScope>('read')
  const [projectSlug, setProjectSlug] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('')
  const [revealed, setRevealed] = useState<ApiKeyWithToken | null>(null)

  const listQuery = useQuery({ queryKey: ['api-keys'], queryFn: () => apiKeysApi.list() })
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: () => projectsApi.list() })

  const projectNameById = (projectsQuery.data ?? []).reduce<Record<string, string>>((acc, p) => {
    acc[p.id] = p.name
    return acc
  }, {})

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
  const canCreateWriteKeys = user?.role === 'owner' || user?.role === 'editor'

  return (
    <div>
      {dialog}
      <SHeader
        title="API keys"
        description="Long-lived bearer tokens for non-browser clients (LLM agents, CLI scripts)."
        actions={
          <Button
            size="sm"
            onClick={() => {
              if (!canCreateWriteKeys) setScope('read')
              setShowForm(true)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Create key
          </Button>
        }
      />

      <div
        className="mb-5 flex gap-2.5 rounded-[10px] px-3.5 py-3"
        style={{
          background: 'var(--warning-soft)',
          border: '1px solid color-mix(in oklab, var(--warning) 35%, var(--border))',
        }}
      >
        <Lock className="mt-px h-[15px] w-[15px] shrink-0" style={{ color: 'var(--warning)' }} />
        <div className="text-[12.5px] leading-[1.5]" style={{ color: 'var(--fg-muted)' }}>
          Keys are shown in full only once at creation. Treat them like passwords — revoke
          immediately if exposed.
        </div>
      </div>

      <SCard title="Active keys" description={`${keys.length} keys`}>
        {listQuery.isLoading ? (
          <div className="px-[18px] py-3 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            Loading…
          </div>
        ) : keys.length === 0 ? (
          <div className="px-[18px] py-3 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No API keys yet. Create one to give an agent access.
          </div>
        ) : (
          keys.map((k, i) => {
            const expired = k.expires_at && new Date(k.expires_at) < new Date()
            const revoked = k.revoked_at != null
            return (
              <div
                key={k.id}
                className="flex items-center gap-3 px-[18px] py-[13px]"
                style={{
                  borderBottom: i === keys.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                  opacity: revoked || expired ? 0.6 : 1,
                }}
              >
                <div
                  className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--fg-muted)',
                  }}
                >
                  <Lock className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0" style={{ width: 180 }}>
                  <div className="text-[13px] font-medium">{k.name}</div>
                  <div className="mono mt-px text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                    {k.key_prefix}…
                  </div>
                </div>
                <Chip
                  tone={k.scope === 'write' ? 'warning' : 'success'}
                  size="sm"
                  style={{ width: 72, justifyContent: 'center' }}
                >
                  {k.scope}
                </Chip>
                <div className="min-w-0 flex-1 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  {k.project_id
                    ? (projectNameById[k.project_id] ?? k.project_id)
                    : 'All projects'}
                </div>
                <span
                  className="text-[11.5px]"
                  style={{ width: 110, textAlign: 'right', color: 'var(--fg-faint)' }}
                >
                  {revoked
                    ? 'revoked'
                    : expired
                      ? 'expired'
                      : k.last_used_at
                        ? `used ${new Date(k.last_used_at).toLocaleDateString()}`
                        : 'never used'}
                </span>
                {!revoked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void handleRevoke(k)
                    }}
                    disabled={revokeMut.isPending}
                  >
                    Revoke
                  </Button>
                )}
              </div>
            )
          })
        )}
      </SCard>

      {/* Create key — inline page-style form (no modal) */}
      {showForm && (
        <SCard title="New API key" description="Generate a long-lived bearer token for non-browser clients.">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              createMut.mutate()
            }}
            className="grid gap-4 px-[18px] py-4"
          >
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
                  {canCreateWriteKeys && <option value="write">write — full editor access</option>}
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
                <p className="text-xs text-destructive">{getErrorMessage(createMut.error)}</p>
              )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending || !name.trim()}>
                Generate
              </Button>
            </div>
          </form>
        </SCard>
      )}

      {/* One-time token reveal */}
      <Dialog open={revealed != null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your API key now</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <p className="text-sm text-muted-foreground">
              This token is shown only once. Copy it now and store it somewhere safe.
            </p>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
              <code className="flex-1 break-all font-mono text-xs">{revealed?.token}</code>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => {
                  if (revealed) void navigator.clipboard.writeText(revealed.token)
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
