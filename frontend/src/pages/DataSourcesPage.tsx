import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dataSourcesApi } from '@/api/dataSources'
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
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import {
  CheckCircle2,
  Database,
  Lock,
  Pencil,
  Plug,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react'

const EMPTY_DATA_SOURCES: DataSource[] = []

export default function DataSourcesPage() {
  const { dsId } = useParams<{ dsId?: string }>()
  return <ConnectionsTab openDsId={dsId} />
}

function ConnectionsTab({ openDsId }: { openDsId?: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [editingDs, setEditingDs] = useState<DataSource | null>(null)
  const editingDsIdRef = useRef<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const [name, setName] = useState('')
  const [dbType, setDbType] = useState<DbType>('clickhouse')
  const [host, setHost] = useState('')
  const [port, setPort] = useState(8123)

  const handleDbTypeChange = (value: DbType) => {
    const previousDefault = DB_TYPE_OPTIONS.find((o) => o.value === dbType)?.defaultPort
    const nextDefault = DB_TYPE_OPTIONS.find((o) => o.value === value)?.defaultPort
    setDbType(value)
    // Only auto-update port if the user hasn't customized it away from the
    // previous adapter's default.
    if (nextDefault && port === previousDefault) {
      setPort(nextDefault)
    }
  }
  const [databaseName, setDatabaseName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const [editName, setEditName] = useState('')
  const [editHost, setEditHost] = useState('')
  const [editPort, setEditPort] = useState(8123)
  const [editDatabaseName, setEditDatabaseName] = useState('')
  const [editUsername, setEditUsername] = useState('')
  const [editPassword, setEditPassword] = useState('')

  const [testingId, setTestingId] = useState<string | null>(null)

  const dataSourcesQuery = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => dataSourcesApi.list(),
  })
  const dataSources = dataSourcesQuery.data ?? EMPTY_DATA_SOURCES

  const createMut = useMutation({
    mutationFn: () =>
      dataSourcesApi.create({
        name, db_type: dbType, host, port,
        database_name: databaseName, username, password,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dataSources'] })
      resetForm()
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) =>
      dataSourcesApi.update(id, {
        name: editName, host: editHost, port: editPort,
        database_name: editDatabaseName, username: editUsername,
        ...(editPassword ? { password: editPassword } : {}),
      }),
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
                last_test_message: (err as Error).message,
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
    setEditHost(ds.host)
    setEditPort(ds.port)
    setEditDatabaseName(ds.database_name)
    setEditUsername(ds.username)
    setEditPassword('')
  }, [])

  const startEdit = useCallback((ds: DataSource) => {
    populateEditForm(ds)
    navigate(`/data-sources/${ds.id}`, { replace: true })
  }, [navigate, populateEditForm])

  const closeEdit = () => {
    editingDsIdRef.current = null
    setEditingDs(null)
    navigate('/data-sources', { replace: true })
  }

  useEffect(() => {
    if (!openDsId) {
      if (editingDsIdRef.current) {
        editingDsIdRef.current = null
        setEditingDs(null)
      }
      return
    }

    if (openDsId && dataSources.length > 0) {
      const ds = dataSources.find((d: DataSource) => d.id === openDsId)
      if (ds) populateEditForm(ds)
    }
  }, [openDsId, dataSources, populateEditForm])

  const resetForm = () => {
    setShowForm(false)
    setName('')
    setDbType('clickhouse')
    setHost('')
    setPort(8123)
    setDatabaseName('')
    setUsername('')
    setPassword('')
  }

  const healthyCount = dataSources.filter((ds) => ds.last_test_status === 'success').length
  const warningCount = dataSources.filter((ds) => ds.last_test_status === 'failed').length

  return (
    <div className="space-y-5">
      {dialog}

      {/* Compact page header */}
      <div className="flex items-end justify-between gap-6">
        <div className="flex items-baseline gap-2.5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Data sources</h1>
          <span className="mono text-[13px]" style={{ color: 'var(--fg-subtle)' }}>
            {dataSources.length}
          </span>
        </div>
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
          <Button onClick={() => setShowForm(true)} size="sm">
            <Plus className="h-3.5 w-3.5" />
            Add connection
          </Button>
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
                  <Label>Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Production ClickHouse" />
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
              {dbType === 'bigquery' ? (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label>Project ID</Label>
                      <Input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="my-gcp-project" />
                    </div>
                    <div className="grid gap-2">
                      <Label>Default dataset</Label>
                      <Input value={databaseName} onChange={(e) => setDatabaseName(e.target.value)} required placeholder="analytics" />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label>Service account JSON</Label>
                    <textarea
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      rows={6}
                      placeholder='{"type":"service_account", ...}'
                      className="flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-5 gap-3">
                    <div className="col-span-2 grid gap-2">
                      <Label>Host</Label>
                      <Input value={host} onChange={(e) => setHost(e.target.value)} required placeholder="localhost" />
                    </div>
                    <div className="grid gap-2">
                      <Label>Port</Label>
                      <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} required />
                    </div>
                    <div className="col-span-2 grid gap-2">
                      <Label>Database</Label>
                      <Input value={databaseName} onChange={(e) => setDatabaseName(e.target.value)} required placeholder="default" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label>Username</Label>
                      <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="default" />
                    </div>
                    <div className="grid gap-2">
                      <Label>Password</Label>
                      <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>
                </>
              )}
              {createMut.isError && (
                <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>
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
                <Label>Name</Label>
                <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div className="grid grid-cols-5 gap-3">
                <div className="col-span-2 grid gap-2">
                  <Label>Host</Label>
                  <Input value={editHost} onChange={(e) => setEditHost(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label>Port</Label>
                  <Input type="number" value={editPort} onChange={(e) => setEditPort(Number(e.target.value))} />
                </div>
                <div className="col-span-2 grid gap-2">
                  <Label>Database</Label>
                  <Input value={editDatabaseName} onChange={(e) => setEditDatabaseName(e.target.value)} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Username</Label>
                  <Input value={editUsername} onChange={(e) => setEditUsername(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label>Password</Label>
                  <Input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="Leave empty to keep" />
                </div>
              </div>
              {updateMut.isError && (
                <p className="text-sm text-destructive">{(updateMut.error as Error).message}</p>
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
          description="Add a database connection to start scanning for events."
          action={
            <Button onClick={() => setShowForm(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add connection
            </Button>
          }
        />
      )}

      {!dataSourcesQuery.isError && dataSources.length > 0 && (
        <div className="grid gap-3">
          {dataSources.map((ds) => (
            <DataSourceCard
              key={ds.id}
              ds={ds}
              testing={testingId === ds.id}
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
  onTest,
  onEdit,
  onDelete,
}: {
  ds: DataSource
  testing: boolean
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const statusTone: 'success' | 'warning' | 'neutral' =
    ds.last_test_status === 'success'
      ? 'success'
      : ds.last_test_status === 'failed'
        ? 'warning'
        : 'neutral'
  const dotTone = statusTone === 'success' ? 'success' : statusTone === 'warning' ? 'warning' : 'neutral'

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
            title={`${ds.host}:${ds.port}/${ds.database_name}`}
          >
            {ds.host}:{ds.port}/{ds.database_name}
          </div>
        </div>
        {ds.password_set && (
          <span title="Password set" style={{ color: 'var(--fg-subtle)' }}>
            <Lock className="h-3.5 w-3.5" />
          </span>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-1.5 border-t px-3.5 py-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <Chip tone={statusTone === 'success' ? 'success' : statusTone === 'warning' ? 'warning' : 'neutral'} size="xs">
          {statusTone === 'success' ? 'healthy' : statusTone === 'warning' ? 'attention' : 'unverified'}
        </Chip>
        <Chip size="xs">{ds.db_type}</Chip>
        {ds.username && <Chip size="xs">{ds.username}</Chip>}
        <div className="flex-1" />
        <span className="mono text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
          {formatRelative(ds.updated_at)}
        </span>
      </div>

      {ds.last_test_status && ds.last_test_message && (
        <div
          className="flex items-center gap-1.5 border-t px-3.5 py-2 text-[11.5px]"
          style={{
            borderColor: 'var(--border-subtle)',
            color: ds.last_test_status === 'success' ? 'var(--success)' : 'var(--danger)',
            background:
              ds.last_test_status === 'success' ? 'var(--success-soft)' : 'var(--danger-soft)',
          }}
        >
          {ds.last_test_status === 'success' ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : (
            <XCircle className="h-3 w-3" />
          )}
          <span className="truncate">{ds.last_test_message}</span>
          {ds.last_test_at && (
            <span
              className="mono ml-auto shrink-0 text-[10.5px]"
              style={{ color: 'var(--fg-faint)' }}
            >
              {formatRelative(ds.last_test_at)}
            </span>
          )}
        </div>
      )}

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
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
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
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
