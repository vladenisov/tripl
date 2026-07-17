import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dataSourcesApi } from '@/api/dataSources'
import { useAuth } from '@/components/auth-context'
import { useConfirm } from '@/hooks/useConfirm'
import type { DataSource, DbType } from '@/types'
import { DB_TYPE_OPTIONS } from '@/types'
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
import { ConnectionSettingsFields } from '@/components/data-sources/connection-settings-fields'
import { ConnectionCoreFields } from '@/components/data-sources/connection-core-fields'
import {
  EMPTY_CONNECTION_CORE_FORM,
  buildCoreCreatePayload,
  buildCoreUpdatePayload,
  dataSourceToCoreForm,
  type ConnectionCoreForm,
} from '@/components/data-sources/connection-core'
import {
  EMPTY_CONNECTION_SETTINGS_FORM,
  buildConnectionSettings,
  connectionSettingsToForm,
  type ConnectionSettingsForm,
} from '@/components/data-sources/connection-settings'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { SyntheticSourceBadge } from '@/demo/capabilityBadges'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import {
  CheckCircle2,
  Clock,
  Database,
  Lock,
  Pencil,
  Plug,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react'
import { dataSourceHealthLexeme } from '@/lib/statusLexicon'
import { getErrorMessage } from '@/lib/utils'
import { formatDate } from '@/lib/datetime'

const EMPTY_DATA_SOURCES: DataSource[] = []

// A successful connection test older than this is no longer a trustworthy
// "healthy" signal — connections can silently break between manual checks, so
// we surface staleness instead of a confident green status.
const HEALTH_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function isHealthCheckStale(ds: DataSource, now: number = Date.now()): boolean {
  if (ds.last_test_status !== 'success' || !ds.last_test_at) return false
  return now - new Date(ds.last_test_at).getTime() > HEALTH_STALE_AFTER_MS
}

export default function DataSourcesPage() {
  const { dsId } = useParams<{ dsId?: string }>()
  return <ConnectionsTab openDsId={dsId} />
}

function ConnectionsTab({ openDsId }: { openDsId?: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()
  const [showForm, setShowForm] = useState(false)
  const [editingDs, setEditingDs] = useState<DataSource | null>(null)
  const editingDsIdRef = useRef<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const [name, setName] = useState('')
  const [dbType, setDbType] = useState<DbType>('clickhouse')
  const [core, setCore] = useState<ConnectionCoreForm>(EMPTY_CONNECTION_CORE_FORM)
  const patchCore = (patch: Partial<ConnectionCoreForm>) =>
    setCore((prev) => ({ ...prev, ...patch }))
  const [settings, setSettings] = useState<ConnectionSettingsForm>(EMPTY_CONNECTION_SETTINGS_FORM)
  const patchSettings = (patch: Partial<ConnectionSettingsForm>) =>
    setSettings((prev) => ({ ...prev, ...patch }))

  const handleDbTypeChange = (value: DbType) => {
    const previousDefault = DB_TYPE_OPTIONS.find((o) => o.value === dbType)?.defaultPort
    const nextDefault = DB_TYPE_OPTIONS.find((o) => o.value === value)?.defaultPort
    setDbType(value)
    // Only auto-update port if the user hasn't customized it away from the
    // previous adapter's default.
    if (nextDefault && core.port === previousDefault) {
      patchCore({ port: nextDefault })
    }
  }

  const [editName, setEditName] = useState('')
  const [editCore, setEditCore] = useState<ConnectionCoreForm>(EMPTY_CONNECTION_CORE_FORM)
  const patchEditCore = (patch: Partial<ConnectionCoreForm>) =>
    setEditCore((prev) => ({ ...prev, ...patch }))
  const [editSettings, setEditSettings] = useState<ConnectionSettingsForm>(
    EMPTY_CONNECTION_SETTINGS_FORM,
  )
  const patchEditSettings = (patch: Partial<ConnectionSettingsForm>) =>
    setEditSettings((prev) => ({ ...prev, ...patch }))

  const [testingId, setTestingId] = useState<string | null>(null)
  const canManageDataSources = user?.role === 'owner'

  const dataSourcesQuery = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => dataSourcesApi.list(),
  })
  const dataSources = dataSourcesQuery.data ?? EMPTY_DATA_SOURCES

  const createMut = useMutation({
    mutationFn: () => {
      const connectionSettings = buildConnectionSettings(dbType, settings)
      return dataSourcesApi.create({
        name,
        db_type: dbType,
        ...buildCoreCreatePayload(dbType, core),
        ...(connectionSettings ? { connection_settings: connectionSettings } : {}),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dataSources'] })
      resetForm()
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => {
      const editDbType = editingDs?.db_type
      if (!editDbType) throw new Error('No data source is being edited')
      const connectionSettings = buildConnectionSettings(editDbType, editSettings)
      return dataSourcesApi.update(id, {
        name: editName,
        // Branches on the warehouse exactly like the create payload does:
        // BigQuery gets no port and no username, and the secret is only sent
        // when the operator typed a new one.
        ...buildCoreUpdatePayload(editDbType, editCore),
        ...(connectionSettings ? { connection_settings: connectionSettings } : {}),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dataSources'] })
      closeEdit()
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => dataSourcesApi.del(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dataSources'] }),
  })

  const handleDelete = async (ds: DataSource) => {
    const ok = await confirm({
      title: 'Delete data source',
      message: `Delete "${ds.name}"? All associated scan configs and jobs will be removed.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(ds.id)
  }

  const handleTest = async (id: string) => {
    setTestingId(id)
    try {
      const result = await dataSourcesApi.testConnection(id)
      qc.setQueryData<DataSource[] | undefined>(['dataSources'], (prev) =>
        prev?.map((ds) => (ds.id === id ? result.data_source : ds)),
      )
    } catch (err) {
      // HTTP failure before the backend persisted anything — reflect it locally
      // so the card shows the error instead of stale "unverified" state.
      qc.setQueryData<DataSource[] | undefined>(['dataSources'], (prev) =>
        prev?.map((ds) =>
          ds.id === id
            ? {
                ...ds,
                last_test_at: new Date().toISOString(),
                last_test_status: 'failed',
                last_test_message: getErrorMessage(err),
              }
            : ds,
        ),
      )
    } finally {
      setTestingId(null)
    }
  }

  const populateEditForm = useCallback((ds: DataSource) => {
    if (editingDsIdRef.current === ds.id) return
    editingDsIdRef.current = ds.id
    setEditingDs(ds)
    setEditName(ds.name)
    // Neither helper prefills a secret: the API returns `password_set` /
    // `sslkey_set` booleans, never the credential itself.
    setEditCore(dataSourceToCoreForm(ds))
    setEditSettings(connectionSettingsToForm(ds.connection_settings))
  }, [])

  const startEdit = useCallback((ds: DataSource) => {
    populateEditForm(ds)
    navigate(`/settings/data-sources/${ds.id}`, { replace: true })
  }, [navigate, populateEditForm])

  const closeEdit = () => {
    editingDsIdRef.current = null
    setEditingDs(null)
    navigate('/settings/data-sources', { replace: true })
  }

  useEffect(() => {
    if (!openDsId) {
      if (editingDsIdRef.current) {
        editingDsIdRef.current = null
        setEditingDs(null)
      }
      return
    }

    if (openDsId && !canManageDataSources) {
      navigate('/settings/data-sources', { replace: true })
      return
    }

    if (openDsId && dataSources.length > 0) {
      const ds = dataSources.find((d: DataSource) => d.id === openDsId)
      if (ds) populateEditForm(ds)
    }
  }, [openDsId, dataSources, populateEditForm, canManageDataSources, navigate])

  const resetForm = () => {
    setShowForm(false)
    setName('')
    setDbType('clickhouse')
    setCore(EMPTY_CONNECTION_CORE_FORM)
    setSettings(EMPTY_CONNECTION_SETTINGS_FORM)
  }

  const healthyCount = dataSources.filter(
    (ds) => ds.last_test_status === 'success' && !isHealthCheckStale(ds),
  ).length
  const warningCount = dataSources.filter((ds) => ds.last_test_status === 'failed').length

  return (
    <div className="space-y-5">
      {dialog}

      {/* Compact stats header (page title comes from the Settings tab bar) */}
      <div className="flex items-end justify-end gap-6">
        <div className="flex items-center gap-4">
          <MiniStat label="Connections" value={String(dataSources.length)} />
          <MiniStatDivider />
          <MiniStat
            label="Healthy"
            value={String(healthyCount)}
            delta={healthyCount > 0 ? 'up' : undefined}
            tone="success"
            pulse={healthyCount > 0}
          />
          <MiniStatDivider />
          <MiniStat
            label="Warnings"
            value={String(warningCount)}
            tone={warningCount > 0 ? 'danger' : 'neutral'}
          />
          {canManageDataSources && (
            <Button onClick={() => setShowForm(true)} size="sm">
              <Plus className="h-3.5 w-3.5" />
              Add connection
            </Button>
          )}
        </div>
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={(v) => { if (!v) resetForm() }}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={(e) => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader>
              <DialogTitle>New data source</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2 grid gap-2">
                  <Label htmlFor="ds-name">Name</Label>
                  <Input id="ds-name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Production ClickHouse" />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ds-type">Type</Label>
                  <select
                    id="ds-type"
                    value={dbType}
                    onChange={(e) => handleDbTypeChange(e.target.value as DbType)}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {DB_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <ConnectionCoreFields
                idPrefix="ds"
                dbType={dbType}
                value={core}
                onChange={patchCore}
                mode="create"
              />
              <ConnectionSettingsFields
                idPrefix="ds"
                dbType={dbType}
                value={settings}
                onChange={patchSettings}
              />
              {createMut.isError && (
                <p className="text-sm text-destructive">{getErrorMessage(createMut.error)}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingDs} onOpenChange={(v) => { if (!v) closeEdit() }}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={(e) => { e.preventDefault(); if (editingDs) updateMut.mutate(editingDs.id) }}>
            <DialogHeader>
              <DialogTitle>Edit data source</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-ds-name">Name</Label>
                <Input id="edit-ds-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              {editingDs && (
                <>
                  {/* Same component as the create dialog, so a BigQuery source is
                      edited as project id / dataset / service-account JSON — not
                      as host / port / username. */}
                  <ConnectionCoreFields
                    idPrefix="edit-ds"
                    dbType={editingDs.db_type}
                    value={editCore}
                    onChange={patchEditCore}
                    mode="edit"
                    secretSet={editingDs.password_set}
                  />
                  <ConnectionSettingsFields
                    idPrefix="edit-ds"
                    dbType={editingDs.db_type}
                    value={editSettings}
                    onChange={patchEditSettings}
                    sslkeySet={editingDs.connection_settings?.sslkey_set ?? false}
                  />
                </>
              )}
              {updateMut.isError && (
                <p className="text-sm text-destructive">{getErrorMessage(updateMut.error)}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => closeEdit()}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {dataSourcesQuery.isError && (
        <ErrorState
          title="Failed to load data sources"
          description="The page could not fetch connection data from the backend."
          error={dataSourcesQuery.error}
          onRetry={() => { void dataSourcesQuery.refetch() }}
        />
      )}

      {!dataSourcesQuery.isError && dataSources.length === 0 && (
        <EmptyState
          icon={Database}
          title="No data sources"
          description={
            canManageDataSources
              ? 'Add a database connection to start scanning for events.'
              : 'Data source connections are managed by owners.'
          }
          action={canManageDataSources ? (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add connection
            </Button>
          ) : undefined}
        />
      )}

      {!dataSourcesQuery.isError && dataSources.length > 0 && (
        <div className="grid gap-3">
          {dataSources.map((ds) => (
            <DataSourceCard
              key={ds.id}
              ds={ds}
              testing={testingId === ds.id}
              canManage={canManageDataSources}
              onTest={() => handleTest(ds.id)}
              onEdit={() => startEdit(ds)}
              onDelete={() => { void handleDelete(ds) }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function DataSourceCard({
  ds,
  testing,
  canManage,
  onTest,
  onEdit,
  onDelete,
}: {
  ds: DataSource
  testing: boolean
  canManage: boolean
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const lastTestAt = ds.last_test_at
  const stale = isHealthCheckStale(ds)
  // Canonical {label, tone} from the status lexicon: a failed test reads red
  // (an error — matching the inline failure banner below), a stale "healthy"
  // check reads amber. Keeps this card in step with the overview list.
  const health = dataSourceHealthLexeme(ds.last_test_status, stale)
  const statusTone = health.tone
  const statusLabel = health.label
  const dotTone = health.tone
  // A failed test or a stale "healthy" check both leave the user stuck with a
  // problem and no obvious next step, so we surface inline recovery actions
  // (re-test / edit) right where the failure is reported, not just in the
  // card's management footer.
  const needsRecovery = stale || ds.last_test_status === 'failed'
  // BigQuery has no port (the adapter deletes it) and no username, so the usual
  // host:port/database summary would print a meaningless ":8123". It is a
  // project and a dataset.
  const isBigQuery = ds.db_type === 'bigquery'
  const connectionLabel = isBigQuery
    ? `${ds.host}/${ds.database_name}`
    : `${ds.host}:${ds.port}/${ds.database_name}`
  const secretLabel = isBigQuery ? 'Service account key set' : 'Password set'

  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border transition-colors hover:border-[var(--border-strong)]"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-start gap-3 p-3.5">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md font-bold uppercase"
          style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.04em',
          }}
        >
          {ds.db_type.slice(0, 2)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Dot tone={dotTone} size={6} pulse={dotTone === 'success'} />
            <span className="truncate text-[13px] font-semibold">{ds.name}</span>
          </div>
          <div
            className="mono mt-0.5 truncate text-[11px]"
            style={{ color: 'var(--fg-subtle)' }}
            title={connectionLabel}
          >
            {connectionLabel}
          </div>
        </div>
        {ds.password_set && (
          <span title={secretLabel} style={{ color: 'var(--fg-subtle)' }}>
            <Lock className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-1.5 border-t px-3.5 py-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <Chip tone={statusTone} size="xs">
          {statusLabel}
        </Chip>
        <Chip size="xs">{ds.db_type}</Chip>
        {ds.is_synthetic && <SyntheticSourceBadge />}
        {ds.username && <Chip size="xs">{ds.username}</Chip>}
        {ds.timeout_seconds != null && <Chip size="xs">timeout {ds.timeout_seconds}s</Chip>}
        <div className="flex-1" />
        <span className="mono text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
          {formatRelative(ds.updated_at)}
        </span>
      </div>

      {ds.last_test_status && ds.last_test_message && (
        <div
          className="border-t text-[11.5px]"
          style={{
            borderColor: 'var(--border-subtle)',
            color: stale
              ? 'var(--warning)'
              : ds.last_test_status === 'success'
                ? 'var(--success)'
                : 'var(--danger)',
            background: stale
              ? 'var(--warning-soft)'
              : ds.last_test_status === 'success'
                ? 'var(--success-soft)'
                : 'var(--danger-soft)',
          }}
        >
          <div className="flex items-center gap-1.5 px-3.5 py-2">
            {stale ? (
              <Clock className="h-3 w-3 shrink-0" />
            ) : ds.last_test_status === 'success' ? (
              <CheckCircle2 className="h-3 w-3 shrink-0" />
            ) : (
              <XCircle className="h-3 w-3 shrink-0" />
            )}
            <span className="truncate" title={stale ? ds.last_test_message ?? undefined : undefined}>
              {stale && lastTestAt ? `Last checked ${formatDate(lastTestAt)}` : ds.last_test_message}
            </span>
            {lastTestAt && (
              <span
                className="mono ml-auto shrink-0 text-[10.5px]"
                style={{ color: 'var(--fg-faint)' }}
              >
                {stale ? 're-test to confirm' : formatRelative(lastTestAt)}
              </span>
            )}
          </div>
          {canManage && needsRecovery && (
            <div className="flex items-center gap-1 px-2.5 pb-2.5">
              <Button variant="outline" size="xs" onClick={onTest} disabled={testing}>
                <Plug className="h-3 w-3" />
                {testing ? 'Re-testing…' : 'Re-test connection'}
              </Button>
              <Button variant="ghost" size="xs" onClick={onEdit}>
                <Pencil className="h-3 w-3" />
                Edit connection
              </Button>
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div
          className="flex items-center gap-1 border-t px-2.5 py-2"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
        >
          <Button variant="ghost" size="sm" onClick={onTest} disabled={testing}>
            <Plug className="h-3 w-3" />
            {testing ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label={`Delete data source ${ds.name}`}
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

function formatRelative(iso: string): string {
  const date = new Date(iso)
  const delta = Date.now() - date.getTime()
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(iso)
}
