import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Lock, Plus } from 'lucide-react'
import { apiKeysApi } from '@/api/apiKeys'
import { projectsQueryOptions } from '@/lib/queryKeys'
import { useAuth } from '@/components/auth-context'
import { ErrorState } from '@/components/error-state'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { INPUT_BASE } from '@/components/settings/input-style'
import { useConfirm } from '@/hooks/useConfirm'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { formatIsoDate } from '@/lib/datetime'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { getErrorMessage } from '@/lib/utils'
import { Field, SCard, SHeader, Select, TextInput } from '@/components/settings/kit'
import { describeKeyCounts, isKeyInactive } from './apiKeyStatus'
import type { ApiKey, ApiKeyScope, ApiKeyWithToken } from '@/types'
import { canWrite } from '@/lib/permissions'

const MAX_EXPIRY_DAYS = 3650

/** Inline error for the optional expiry, or null when it is blank or valid. */
function expiryError(raw: string): string | null {
  if (raw.trim() === '') return null
  const days = Number(raw)
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
    return `Enter a whole number of days from 1 to ${MAX_EXPIRY_DAYS}, or leave it blank.`
  }
  return null
}

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
  const tokenRef = useRef<HTMLInputElement>(null)
  const { state: copyState, copy, reset: resetCopy } = useCopyToClipboard(tokenRef)

  const listQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => apiKeysApi.list(),
    meta: SILENT_ERROR_META,
  })
  const projectsQuery = useQuery(projectsQueryOptions())

  const projectNameById = (projectsQuery.data ?? []).reduce<Record<string, string>>((acc, p) => {
    acc[p.id] = p.name
    return acc
  }, {})

  const resetDraft = () => {
    setName('')
    setScope('read')
    setProjectSlug('')
    setExpiresInDays('')
  }

  const createMut = useMutation({
    mutationFn: () =>
      apiKeysApi.create({
        name: name.trim(),
        scope,
        expires_in_days: expiresInDays ? Number(expiresInDays) : null,
        project_slug: projectSlug || null,
      }),
    meta: SILENT_ERROR_META,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      setShowForm(false)
      resetCopy()
      setRevealed(created)
      resetDraft()
    },
  })

  // Cancel used to only hide the card, so the next "Create key" reopened it
  // with the abandoned name, scope and the previous failure still showing.
  const cancelForm = () => {
    setShowForm(false)
    resetDraft()
    createMut.reset()
  }

  const revokeMut = useMutation({
    mutationFn: (keyId: string) => apiKeysApi.revoke(keyId),
    // Rendered below the list: a failed revoke on a credentials surface must
    // not read as a revoke that worked.
    meta: SILENT_ERROR_META,
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
  const canCreateWriteKeys = canWrite(user?.role)
  const expiryProblem = expiryError(expiresInDays)
  const failedRevokeName = revokeMut.isError
    ? keys.find((k) => k.id === revokeMut.variables)?.name
    : undefined

  // The card used to headline "Active keys · N keys" off the unfiltered list,
  // so revoked and expired tokens were counted as live ones on a credentials
  // surface (tripl-jfm3.33). Count only the keys that can still authenticate,
  // and name the inactive remainder explicitly.
  const inactiveCount = keys.filter((k) => isKeyInactive(k)).length
  const activeCount = keys.length - inactiveCount

  const scopeOptions = [
    { value: 'read', label: 'read — GET endpoints only' },
    ...(canCreateWriteKeys ? [{ value: 'write', label: 'write — full editor access' }] : []),
  ]
  const projectOptions = [
    { value: '', label: 'All projects — full account reach' },
    ...(projectsQuery.data ?? []).map((p) => ({ value: p.slug, label: p.name })),
  ]

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

      {/* Create key — inline page-style form (no modal). Kit rows and the kit
          Select, not bare <select>s: a native select keeps the platform's light
          widget in dark mode (tripl-h3bb). */}
      {showForm && (
        <SCard title="New API key" description="Generate a long-lived bearer token for non-browser clients.">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (expiryProblem) return
              createMut.mutate()
            }}
          >
            <Field label="Name" htmlFor="key-name">
              <input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. claude-agent"
                required
                // eslint-disable-next-line jsx-a11y/no-autofocus -- form revealed by explicit "Create key" click; focusing its first input is expected
                autoFocus
                style={INPUT_BASE}
              />
            </Field>
            <Field label="Scope" htmlFor="key-scope">
              <Select
                id="key-scope"
                value={scope}
                onChange={(value) => setScope(value as ApiKeyScope)}
                options={scopeOptions}
              />
            </Field>
            <Field label="Project (optional)" htmlFor="key-project">
              <Select
                id="key-project"
                value={projectSlug}
                onChange={setProjectSlug}
                options={projectOptions}
              />
            </Field>
            <Field
              label="Expires in (optional)"
              htmlFor="key-expires"
              hint={
                expiryProblem ? (
                  <span id="key-expires-error" style={{ color: 'var(--danger)' }}>
                    {expiryProblem}
                  </span>
                ) : (
                  'Leave blank for a key that never expires.'
                )
              }
              last
            >
              <TextInput
                id="key-expires"
                type="number"
                value={expiresInDays}
                onChange={setExpiresInDays}
                suffix="days"
                aria-invalid={expiryProblem != null}
                aria-describedby={expiryProblem ? 'key-expires-error' : undefined}
              />
            </Field>
            <div
              className="flex flex-wrap items-center justify-end gap-2 px-[18px] py-3"
              style={{ borderTop: '1px solid var(--border-subtle)' }}
            >
              {createMut.isError && (
                <p role="alert" className="mr-auto text-xs text-destructive">
                  {getErrorMessage(createMut.error)}
                </p>
              )}
              <Button type="button" variant="outline" onClick={cancelForm}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMut.isPending || !name.trim() || expiryProblem != null}
              >
                {createMut.isPending ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </form>
        </SCard>
      )}

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

      <SCard
        title="All keys"
        // No count until there is a list to count: "0 active" above a failed
        // load reads as "you have no credentials".
        description={listQuery.isSuccess ? describeKeyCounts(activeCount, inactiveCount) : undefined}
      >
        {listQuery.isPending ? (
          <div aria-busy="true" aria-label="Loading API keys" className="space-y-3 px-[18px] py-3">
            {[0, 1].map((index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-[30px] w-[30px] shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : listQuery.isError ? (
          // A failed load used to fall through to "No API keys yet", so live
          // keys looked nonexistent and invited minting duplicates.
          <div className="px-[18px] py-3">
            <ErrorState
              compact
              title="Couldn't load API keys"
              error={listQuery.error}
              onRetry={() => {
                void listQuery.refetch()
              }}
            />
          </div>
        ) : keys.length === 0 ? (
          <div className="px-[18px] py-3 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No API keys yet. Create one to give an agent access.
          </div>
        ) : (
          keys.map((k, i) => {
            // One rule for the row and the heading count: isKeyInactive is
            // inclusive at the expiry instant, like the backend.
            const revoked = k.revoked_at != null
            const expired = !revoked && isKeyInactive(k)
            const revoking = revokeMut.isPending && revokeMut.variables === k.id
            return (
              <div
                key={k.id}
                // A grid on phones — icon, name and Revoke on the first line,
                // scope, project and status below — and one flex line from
                // `sm` up. The fixed-width single line measured ~560px and
                // overflowed a 375px card.
                className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-[18px] py-[13px] sm:flex"
                style={{
                  borderBottom: i === keys.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                  opacity: revoked || expired ? 0.6 : 1,
                }}
              >
                <div
                  className="col-start-1 row-start-1 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--fg-muted)',
                  }}
                >
                  <Lock className="h-3.5 w-3.5" />
                </div>
                <div className="col-start-2 row-start-1 min-w-0 sm:w-[180px] sm:shrink-0">
                  <div className="truncate text-[13px] font-medium" title={k.name}>
                    {k.name}
                  </div>
                  <div className="mono mt-px truncate text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                    {k.key_prefix}… · created {formatIsoDate(k.created_at)}
                  </div>
                </div>
                <div className="col-span-2 col-start-2 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 sm:contents">
                  <Chip
                    tone={k.scope === 'write' ? 'warning' : 'success'}
                    size="sm"
                    className="justify-center sm:w-[72px] sm:shrink-0"
                  >
                    {k.scope}
                  </Chip>
                  <div
                    className="min-w-0 truncate text-[11.5px] sm:flex-1"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    {k.project_id
                      ? (projectNameById[k.project_id] ?? k.project_id)
                      : 'All projects'}
                  </div>
                  <div
                    className="text-[11.5px] sm:w-[130px] sm:shrink-0 sm:text-right"
                    style={{ color: 'var(--fg-faint)' }}
                  >
                    <div>
                      {revoked
                        ? 'revoked'
                        : expired
                          ? 'expired'
                          : k.last_used_at
                            ? `used ${formatIsoDate(k.last_used_at)}`
                            : 'never used'}
                    </div>
                    {!revoked && !expired && (
                      <div>
                        {k.expires_at ? `expires ${formatIsoDate(k.expires_at)}` : 'no expiry'}
                      </div>
                    )}
                  </div>
                </div>
                {!revoked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="col-start-3 row-start-1"
                    onClick={() => {
                      void handleRevoke(k)
                    }}
                    disabled={revoking}
                  >
                    {revoking ? 'Revoking…' : 'Revoke'}
                    <span className="sr-only"> {k.name}</span>
                  </Button>
                )}
              </div>
            )
          })
        )}
        {revokeMut.isError && (
          <p role="alert" className="px-[18px] py-3 text-xs text-destructive">
            {failedRevokeName
              ? `Couldn't revoke "${failedRevokeName}" — it is still active. `
              : "Couldn't revoke the key — it is still active. "}
            {getErrorMessage(revokeMut.error)}
          </p>
        )}
      </SCard>

      {/* One-time token reveal. Only "Done" closes it: Esc or a stray click
          outside used to discard a token the server never returns again. */}
      <Dialog open={revealed != null}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Copy your API key now</DialogTitle>
            <DialogDescription>
              This token is shown only once. Copy it now and store it somewhere safe.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <div className="flex items-center gap-2">
              <input
                ref={tokenRef}
                readOnly
                aria-label="API key"
                value={revealed?.token ?? ''}
                onFocus={(e) => e.currentTarget.select()}
                className="mono h-9 min-w-0 flex-1 rounded-md border px-2 text-xs"
                style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--fg)' }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (revealed) void copy(revealed.token)
                }}
              >
                <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                {copyState === 'copied' ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div aria-live="polite" aria-atomic="true">
              {copyState === 'copied' && (
                <p className="text-[11.5px]" style={{ color: 'var(--success)' }}>
                  Copied to the clipboard.
                </p>
              )}
            </div>
            {copyState === 'failed' && (
              <p role="alert" className="text-[11.5px]" style={{ color: 'var(--danger)' }}>
                Couldn’t reach the clipboard. The key above is selected — press Ctrl/⌘+C to copy it.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setRevealed(null)
                resetCopy()
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
