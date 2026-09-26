import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dataSourcesApi } from '@/api/dataSources'
import { useAuth } from '@/components/auth-context'
import { useConfirm } from '@/hooks/useConfirm'
import {
  UNSAVED_CHANGES_MESSAGE,
  useDirtySinceOpen,
  useUnsavedDialogGuard,
} from '@/hooks/useUnsavedChangesGuard'
import { LEAVE_CONFIRMED, useUnsavedChanges } from '@/components/settings/unsaved-changes'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import type { DataSource, DbType } from '@/types'
import { DB_TYPE_OPTIONS } from '@/types'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import {
  Dialog,
  DialogBody,
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
  connectionCoreMissing,
  buildCoreUpdatePayload,
  connectionCoreSecretError,
  coreConnectionChanged,
  dataSourceToCoreForm,
  type ConnectionCoreForm,
  type CoreMissing,
} from '@/components/data-sources/connection-core'
import { FieldError } from '@/components/forms/FieldError'
import { examplePlaceholder } from '@/components/forms/placeholders'
import { REQUIRED_MESSAGE, focusFirstInvalid, invalidAria } from '@/components/forms/validation'
import {
  EMPTY_CONNECTION_SETTINGS_FORM,
  SELECT_CLASS,
  buildConnectionSettings,
  connectionSettingsErrors,
  connectionSettingsToForm,
  type ConnectionSettingsForm,
  type PemErrors,
} from '@/components/data-sources/connection-settings'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { StatValueSkeleton } from '@/components/states'
import { Skeleton } from '@/components/ui/skeleton'
import { SyntheticSourceBadge } from '@/demo/capabilityBadges'
import { Chip } from '@/components/primitives/chip'
import { MiniStat, MiniStatStrip } from '@/components/primitives/mini-stat'
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
import { formatDate, formatRelativeTime } from '@/lib/datetime'
import { dataSourcesKey } from '@/lib/queryKeys'
import { isOwner } from '@/lib/permissions'

const EMPTY_DATA_SOURCES: DataSource[] = []

// A successful connection test older than this is no longer a trustworthy
// "healthy" signal — connections can silently break between manual checks, so
// we surface staleness instead of a confident green status.
const HEALTH_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function isHealthCheckStale(ds: DataSource, now: number = Date.now()): boolean {
  if (ds.last_test_status !== 'success' || !ds.last_test_at) return false
  return now - new Date(ds.last_test_at).getTime() > HEALTH_STALE_AFTER_MS
}

/**
 * Inline validation for the connection dialogs (DATA-29): a malformed
 * service-account key or PEM block is caught here instead of at connect time.
 *
 * Only fields that differ from `baseline` are checked. On edit the baseline is
 * the stored settings, so a certificate saved before this check existed cannot
 * block an unrelated rename; on create it is the empty form.
 */
interface ConnectionErrors {
  secret: string | null
  pem: PemErrors
  /** Required core fields left empty, flagged inline under each (AU-4). */
  missing: CoreMissing
}

const NO_CONNECTION_ERRORS: ConnectionErrors = { secret: null, pem: {}, missing: {} }

function connectionErrors(
  dbType: DbType,
  core: ConnectionCoreForm,
  settings: ConnectionSettingsForm,
  baseline: ConnectionSettingsForm,
  mode: 'create' | 'edit',
): ConnectionErrors {
  const pem: PemErrors = {}
  const all = connectionSettingsErrors(dbType, settings)
  for (const field of ['sslrootcert', 'sslcert', 'sslkey'] as const) {
    const error = all[field]
    if (error && settings[field] !== baseline[field]) pem[field] = error
  }
  return {
    secret: connectionCoreSecretError(dbType, core),
    pem,
    missing: connectionCoreMissing(dbType, core, mode, REQUIRED_MESSAGE),
  }
}

function hasConnectionErrors(errors: ConnectionErrors): boolean {
  return !!errors.secret || Object.keys(errors.pem).length > 0 || Object.keys(errors.missing).length > 0
}

/**
 * After a refused submit, move focus to the first flagged control once the
 * render that marks it has landed (AL-4 / AU-4): in a long dialog the
 * message could sit below the fold with nothing pointing at it.
 */
function focusFirstInvalidSoon(root: HTMLElement | null) {
  if (!root) return
  requestAnimationFrame(() => focusFirstInvalid(root))
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
  // Validation errors shown after a submit attempt; cleared as the user edits.
  const [createErrors, setCreateErrors] = useState<ConnectionErrors>(NO_CONNECTION_ERRORS)
  const [editErrors, setEditErrors] = useState<ConnectionErrors>(NO_CONNECTION_ERRORS)
  const [editNameError, setEditNameError] = useState<string | null>(null)
  const [createNameError, setCreateNameError] = useState<string | null>(null)
  const createFormRef = useRef<HTMLFormElement>(null)
  const editFormRef = useRef<HTMLFormElement>(null)

  const [name, setName] = useState('')
  const [dbType, setDbType] = useState<DbType>('clickhouse')
  const [core, setCore] = useState<ConnectionCoreForm>(EMPTY_CONNECTION_CORE_FORM)
  const patchCore = (patch: Partial<ConnectionCoreForm>) => {
    setCore((prev) => ({ ...prev, ...patch }))
    setCreateErrors(NO_CONNECTION_ERRORS)
  }
  const [settings, setSettings] = useState<ConnectionSettingsForm>(EMPTY_CONNECTION_SETTINGS_FORM)
  const patchSettings = (patch: Partial<ConnectionSettingsForm>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
    setCreateErrors(NO_CONNECTION_ERRORS)
  }

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
  const patchEditCore = (patch: Partial<ConnectionCoreForm>) => {
    setEditCore((prev) => ({ ...prev, ...patch }))
    setEditErrors(NO_CONNECTION_ERRORS)
  }
  const [editSettings, setEditSettings] = useState<ConnectionSettingsForm>(
    EMPTY_CONNECTION_SETTINGS_FORM,
  )
  const patchEditSettings = (patch: Partial<ConnectionSettingsForm>) => {
    setEditSettings((prev) => ({ ...prev, ...patch }))
    setEditErrors(NO_CONNECTION_ERRORS)
  }

  // Every source with a test in flight. One shared id let testing A then B
  // re-enable A's button mid-test, and A's finish re-enabled B's (DATA-34).
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(() => new Set())
  const canManageDataSources = isOwner(user?.role)

  const dataSourcesQuery = useQuery({
    queryKey: dataSourcesKey(),
    queryFn: () => dataSourcesApi.list(),
  })
  const dataSources = dataSourcesQuery.data ?? EMPTY_DATA_SOURCES

  // The create body, shared by Create and by Test connection, so the test
  // probes exactly what Create would store.
  const buildCreatePayload = () => {
    const connectionSettings = buildConnectionSettings(dbType, settings)
    return {
      name: name.trim(),
      db_type: dbType,
      ...buildCoreCreatePayload(dbType, core),
      ...(connectionSettings ? { connection_settings: connectionSettings } : {}),
    }
  }

  // Create and update render their error inside their dialog.
  const createMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () => dataSourcesApi.create(buildCreatePayload()),
    onSuccess: (created) => {
      resetForm()
      // Tested again the moment it is saved, so the card shows its health right
      // away instead of "unverified" until the first scan (DATA-30).
      void qc
        .invalidateQueries({ queryKey: dataSourcesKey() })
        .then(() => handleTest(created.id))
    },
  })

  const updateMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: ({ id }: { id: string; retest: boolean }) => {
      const editDbType = editingDs?.db_type
      if (!editDbType) throw new Error('No data source is being edited')
      if (editingDs.is_synthetic) {
        return dataSourcesApi.update(id, {
          name: editName.trim(),
          timeout_seconds: editCore.timeoutSeconds.trim()
            ? Number(editCore.timeoutSeconds)
            : null,
        })
      }
      const connectionSettings = buildConnectionSettings(editDbType, editSettings)
      return dataSourcesApi.update(id, {
        name: editName.trim(),
        // Branches on the warehouse exactly like the create payload does:
        // BigQuery gets no port and no username, and the secret is only sent
        // when the operator typed a new one.
        ...buildCoreUpdatePayload(editDbType, editCore),
        ...(connectionSettings ? { connection_settings: connectionSettings } : {}),
      })
    },
    onSuccess: (_saved, { id, retest }) => {
      closeEdit()
      // A changed host, credential or TLS setting is re-tested right away, so
      // the card never keeps a "healthy" earned by the old connection.
      const refreshed = qc.invalidateQueries({ queryKey: dataSourcesKey() })
      if (retest) void refreshed.then(() => handleTest(id))
    },
  })

  // Delete renders its error on the card it failed for, like scan delete/run
  // failures do on the Scans page (DATA-5), so the global toast stays quiet.
  const deleteMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (id: string) => dataSourcesApi.del(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: dataSourcesKey() }),
  })
  // Stable (the observer binds it once), so the edit-form callback can depend on it.
  const resetUpdate = updateMut.reset
  const failedDeleteId = deleteMut.isError ? deleteMut.variables : undefined

  const handleDelete = async (ds: DataSource) => {
    const ok = await confirm({
      title: 'Delete data source',
      message: `Delete "${ds.name}"? All associated scans and their runs will be removed.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(ds.id)
  }

  const handleTest = async (id: string) => {
    setTestingIds((prev) => new Set(prev).add(id))
    try {
      const result = await dataSourcesApi.testConnection(id)
      qc.setQueryData<DataSource[] | undefined>(dataSourcesKey(), (prev) =>
        prev?.map((ds) => (ds.id === id ? result.data_source : ds)),
      )
    } catch (err) {
      // HTTP failure before the backend persisted anything — reflect it locally
      // so the card shows the error instead of stale "unverified" state.
      qc.setQueryData<DataSource[] | undefined>(dataSourcesKey(), (prev) =>
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
      setTestingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const populateEditForm = useCallback((ds: DataSource) => {
    if (editingDsIdRef.current === ds.id) return
    editingDsIdRef.current = ds.id
    // A failure from another source's save must not greet this one (DATA-32).
    resetUpdate()
    setEditErrors(NO_CONNECTION_ERRORS)
    setEditNameError(null)
    setEditingDs(ds)
    setEditName(ds.name)
    // Neither helper prefills a secret: the API returns `password_set` /
    // `sslkey_set` booleans, never the credential itself.
    setEditCore(dataSourceToCoreForm(ds))
    setEditSettings(connectionSettingsToForm(ds.connection_settings))
  }, [resetUpdate])

  const startEdit = useCallback((ds: DataSource) => {
    populateEditForm(ds)
    navigate(`/settings/data-sources/${ds.id}`, { replace: true })
  }, [navigate, populateEditForm])

  // Every caller has already settled the draft: the dialog guard asked, or
  // there was nothing to ask about, or it was just saved. LEAVE_CONFIRMED tells
  // the settings shell's blocker so, or it would ask a second time.
  const closeEdit = () => {
    editingDsIdRef.current = null
    setEditingDs(null)
    // Drop the typed secret and any stale error with the dialog, rather than
    // keeping a pasted key in memory until the next edit opens (DATA-29,
    // DATA-32).
    setEditCore(EMPTY_CONNECTION_CORE_FORM)
    setEditSettings(EMPTY_CONNECTION_SETTINGS_FORM)
    setEditErrors(NO_CONNECTION_ERRORS)
    setEditNameError(null)
    resetUpdate()
    navigate('/settings/data-sources', { replace: true, state: LEAVE_CONFIRMED })
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

  // Test connection before saving (DATA-30): the unsaved config goes to the
  // server, which probes it and stores nothing. The answer is for the inputs it
  // was run with, so it is hidden as soon as any of them changes.
  const draftKey = JSON.stringify({ dbType, core, settings })
  const draftTestMut = useMutation({
    meta: SILENT_ERROR_META,
    // `key` names the inputs the answer is for.
    mutationFn: ({ payload }: { key: string; payload: ReturnType<typeof buildCreatePayload> }) =>
      dataSourcesApi.testDraft(payload),
  })
  const draftTestShown = draftTestMut.variables?.key === draftKey && !draftTestMut.isPending
  const testDraft = () => {
    const errors = connectionErrors(dbType, core, settings, EMPTY_CONNECTION_SETTINGS_FORM, 'create')
    setCreateErrors(errors)
    if (hasConnectionErrors(errors)) {
      focusFirstInvalidSoon(createFormRef.current)
      return
    }
    draftTestMut.mutate({ key: draftKey, payload: buildCreatePayload() })
  }

  const resetForm = () => {
    setShowForm(false)
    setName('')
    setCreateNameError(null)
    setDbType('clickhouse')
    setCore(EMPTY_CONNECTION_CORE_FORM)
    setSettings(EMPTY_CONNECTION_SETTINGS_FORM)
    setCreateErrors(NO_CONNECTION_ERRORS)
    // Opening "Add connection" after a failed attempt showed the old error.
    createMut.reset()
    draftTestMut.reset()
  }

  const submitCreate = () => {
    const errors = connectionErrors(dbType, core, settings, EMPTY_CONNECTION_SETTINGS_FORM, 'create')
    const nameError = name.trim() ? null : REQUIRED_MESSAGE
    setCreateErrors(errors)
    setCreateNameError(nameError)
    if (nameError || hasConnectionErrors(errors)) {
      focusFirstInvalidSoon(createFormRef.current)
      return
    }
    createMut.mutate()
  }

  const submitEdit = () => {
    if (!editingDs) return
    // The form is `noValidate`; this catches an empty name and a name of
    // spaces, which the backend would otherwise answer with a raw 422 (DATA-33).
    if (!editName.trim()) {
      setEditNameError('Enter a name.')
      focusFirstInvalidSoon(editFormRef.current)
      return
    }
    setEditNameError(null)
    if (editingDs.is_synthetic) {
      updateMut.mutate({ id: editingDs.id, retest: false })
      return
    }
    const baseline = connectionSettingsToForm(editingDs.connection_settings)
    const errors = connectionErrors(editingDs.db_type, editCore, editSettings, baseline, 'edit')
    setEditErrors(errors)
    if (hasConnectionErrors(errors)) {
      focusFirstInvalidSoon(editFormRef.current)
      return
    }
    const settingsChanged = JSON.stringify(editSettings) !== JSON.stringify(baseline)
    updateMut.mutate({
      id: editingDs.id,
      retest: settingsChanged || coreConnectionChanged(editingDs, editCore),
    })
  }

  // One stray overlay click or Escape used to throw away a pasted service-account
  // key or PEM certificate (DATA-31). Both dialogs now ask first while they hold
  // anything the user typed; Cancel asks too, since it is the same loss.
  const createDirty = useDirtySinceOpen(showForm, { name, dbType, core, settings })
  const createGuard = useUnsavedDialogGuard(createDirty)
  const editDirty = useDirtySinceOpen(!!editingDs, { editName, editCore, editSettings })
  const editGuard = useUnsavedDialogGuard(editDirty)
  // The edit dialog has a URL of its own, so browser Back closes it without
  // any of the dialog's close requests running. Registering the draft with the
  // settings shell puts Back (and every other way out of this URL) behind the
  // shell's blocker as well.
  const { registerUnsaved } = useUnsavedChanges()
  const editingId = editingDs?.id
  useEffect(() => {
    registerUnsaved(
      editDirty && editingId
        ? { keptBy: path => path === `data-sources/${editingId}`, message: UNSAVED_CHANGES_MESSAGE }
        : null,
    )
    return () => registerUnsaved(null)
  }, [editDirty, editingId, registerUnsaved])

  const healthyCount = dataSources.filter(
    (ds) => ds.last_test_status === 'success' && !isHealthCheckStale(ds),
  ).length
  // A stale "healthy" check renders amber on its card, so it counts here too;
  // the header read "Warnings 0" above amber cards (DATA-35).
  const warningCount = dataSources.filter(
    (ds) => ds.last_test_status === 'failed' || isHealthCheckStale(ds),
  ).length
  /* Nothing numeric is claimed before the fetch settles: `dataSources` defaults
     to [], so a cold load would otherwise report "Connections 0 / Healthy 0" as
     if those were measurements. ScansTab holds its 24h KPI at "—" for the same
     reason (tripl-jfm3.28). */
  const statsPending = dataSourcesQuery.isLoading

  return (
    <div className="space-y-5">
      {dialog}
      {createGuard.dialog}
      {editGuard.dialog}

      {/* Compact stats header (page title comes from the Settings tab bar).
          It wraps, and is never right-aligned: a non-wrapping `justify-end` row
          overflowed off the LEFT edge at 375px, where nothing can scroll to it,
          and "Connections" read as "TIONS" (DATA-35 / LIVE-4). */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <MiniStatStrip boxed>
          {/* Pending values are a skeleton with no tone (#237 DS-25). */}
          <MiniStat
            label="Connections"
            value={statsPending ? <StatValueSkeleton /> : String(dataSources.length)}
          />
          <MiniStat
            label="Healthy"
            value={statsPending ? <StatValueSkeleton /> : String(healthyCount)}
            delta={!statsPending && healthyCount > 0 ? 'up' : undefined}
            tone={statsPending ? undefined : 'success'}
            pulse={!statsPending && healthyCount > 0}
          />
          <MiniStat
            label="Warnings"
            value={statsPending ? <StatValueSkeleton /> : String(warningCount)}
            tone={!statsPending && warningCount > 0 ? 'danger' : 'neutral'}
          />
        </MiniStatStrip>
        {canManageDataSources && (
          <Button onClick={() => setShowForm(true)} size="sm">
            <Plus className="h-3.5 w-3.5" />
            Add connection
          </Button>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={(v) => { if (!v) createGuard.requestClose(resetForm) }}>
        <DialogContent className="sm:max-w-lg">
          {/* noValidate: every empty required field is flagged inline on
              submit, not by the browser's bubble on the first one (AU-4).
              DialogBody scrolls; the title and actions stay in view (AL-4). */}
          <form
            ref={createFormRef}
            noValidate
            className="flex min-h-0 flex-col gap-4"
            onSubmit={(e) => { e.preventDefault(); submitCreate() }}
          >
            <DialogHeader>
              <DialogTitle>New data source</DialogTitle>
            </DialogHeader>
            <DialogBody className="grid gap-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="ds-name">Name</Label>
                  <Input
                    id="ds-name"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      setCreateNameError(null)
                    }}
                    aria-required
                    placeholder={examplePlaceholder('Production ClickHouse')}
                    {...invalidAria('ds-name', createNameError)}
                  />
                  <FieldError inputId="ds-name" message={createNameError} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="ds-type">Type</Label>
                  <select
                    id="ds-type"
                    value={dbType}
                    onChange={(e) => handleDbTypeChange(e.target.value as DbType)}
                    className={SELECT_CLASS}
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
                secretError={createErrors.secret}
                missing={createErrors.missing}
              />
              <ConnectionSettingsFields
                idPrefix="ds"
                dbType={dbType}
                value={settings}
                onChange={patchSettings}
                pemErrors={createErrors.pem}
              />
              {createMut.isError && (
                <p className="text-body text-destructive">{getErrorMessage(createMut.error)}</p>
              )}
              {draftTestShown && draftTestMut.data && (
                <p
                  role="status"
                  className={draftTestMut.data.success ? 'text-body text-success' : 'text-body text-destructive'}
                >
                  {draftTestMut.data.message}
                </p>
              )}
              {draftTestShown && draftTestMut.isError && (
                <p role="alert" className="text-body text-destructive">
                  {getErrorMessage(draftTestMut.error)}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => createGuard.requestClose(resetForm)}>Cancel</Button>
              <Button
                type="button"
                variant="outline"
                onClick={testDraft}
                disabled={draftTestMut.isPending}
              >
                {draftTestMut.isPending ? 'Testing…' : 'Test connection'}
              </Button>
              <Button type="submit" disabled={createMut.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingDs} onOpenChange={(v) => { if (!v) editGuard.requestClose(closeEdit) }}>
        <DialogContent className="sm:max-w-lg">
          <form
            ref={editFormRef}
            noValidate
            className="flex min-h-0 flex-col gap-4"
            onSubmit={(e) => { e.preventDefault(); submitEdit() }}
          >
            <DialogHeader>
              <DialogTitle>Edit data source</DialogTitle>
            </DialogHeader>
            <DialogBody className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-ds-name">Name</Label>
                <Input
                  id="edit-ds-name"
                  value={editName}
                  onChange={(e) => {
                    setEditName(e.target.value)
                    setEditNameError(null)
                  }}
                  aria-required
                  {...invalidAria('edit-ds-name', editNameError)}
                />
                <FieldError inputId="edit-ds-name" message={editNameError} announce />
              </div>
              {editingDs && (
                <>
                  {editingDs.is_synthetic ? (
                    <div className="grid gap-2">
                      <p className="text-body text-muted-foreground">
                        Demo sources have no warehouse connection to configure.
                      </p>
                      <Label htmlFor="edit-ds-timeout">Timeout, s</Label>
                      <Input
                        id="edit-ds-timeout"
                        type="number"
                        min={1}
                        value={editCore.timeoutSeconds}
                        onChange={(e) => patchEditCore({ timeoutSeconds: e.target.value })}
                        placeholder="Default"
                      />
                    </div>
                  ) : (
                    <>
                      <ConnectionCoreFields
                        idPrefix="edit-ds"
                        dbType={editingDs.db_type}
                        value={editCore}
                        onChange={patchEditCore}
                        mode="edit"
                        secretSet={editingDs.password_set}
                        secretError={editErrors.secret}
                        missing={editErrors.missing}
                      />
                      <ConnectionSettingsFields
                        idPrefix="edit-ds"
                        dbType={editingDs.db_type}
                        value={editSettings}
                        onChange={patchEditSettings}
                        sslkeySet={editingDs.connection_settings?.sslkey_set ?? false}
                        pemErrors={editErrors.pem}
                      />
                    </>
                  )}
                </>
              )}
              {updateMut.isError && (
                <p className="text-body text-destructive">{getErrorMessage(updateMut.error)}</p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => editGuard.requestClose(closeEdit)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {dataSourcesQuery.isLoading && (
        <div className="grid gap-3" aria-busy="true" aria-label="Loading data sources">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-[132px] rounded-lg" />
          ))}
        </div>
      )}

      {dataSourcesQuery.isError && (
        <ErrorState
          title="Failed to load data sources"
          description="The page could not fetch connection data from the backend."
          error={dataSourcesQuery.error}
          onRetry={() => { void dataSourcesQuery.refetch() }}
        />
      )}

      {/* isSuccess, not !isError: an in-flight fetch also has zero rows, and
          offering "Add a database connection" to someone who already has
          connections is a claim the page cannot yet make. */}
      {dataSourcesQuery.isSuccess && dataSources.length === 0 && (
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
              testing={testingIds.has(ds.id)}
              canManage={canManageDataSources}
              onTest={() => handleTest(ds.id)}
              onEdit={() => startEdit(ds)}
              onDelete={() => { void handleDelete(ds) }}
              deleteError={
                failedDeleteId === ds.id ? getErrorMessage(deleteMut.error) : undefined
              }
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
  deleteError,
}: {
  ds: DataSource
  testing: boolean
  canManage: boolean
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
  /** Why the last delete of this source failed, shown on the card itself. */
  deleteError?: string
}) {
  const lastTestAt = ds.last_test_at
  const stale = isHealthCheckStale(ds)
  // Canonical {label, tone} from the status lexicon: a failed test reads red
  // (an error — matching the inline failure banner below), a stale "healthy"
  // check reads amber. Keeps this card in step with the overview list.
  const health = dataSourceHealthLexeme(ds.last_test_status, stale)
  const statusTone = health.tone
  const statusLabel = health.label
  // One health indicator and one type marker per card (LIVE-36). A card used
  // to carry a dot, a health chip AND the last-test row (three health
  // markers), plus a "synthetic" type chip next to the Synthetic badge. The
  // last-test row now leads with the health word; the chip only stands in
  // when there is no row (an untested source).
  const hasTestRow = !!(ds.last_test_status && ds.last_test_message)
  // A failed test or a stale "healthy" check both leave the user stuck with a
  // problem and no obvious next step, so we surface inline recovery actions
  // (re-test / edit) right where the failure is reported, not just in the
  // card's management footer.
  const needsRecovery = stale || ds.last_test_status === 'failed'
  // BigQuery has no port (the adapter deletes it) and no username, so the usual
  // host:port/database summary would print a meaningless ":8123". It is a
  // project and a dataset.
  const isBigQuery = ds.db_type === 'bigquery'
  // Non-owners get the connection redacted server-side (tripl-jfm3.19), so
  // host/port/database_name arrive blank and this summary would render as a
  // bare ":0/" (tripl-jfm3.84). Keyed off the payload rather than the viewer's
  // role on purpose: the response is the ground truth for what we were allowed
  // to see, so this stays correct if the redaction rule changes.
  const connectionRedacted = !ds.host
  const connectionLabel = isBigQuery
    ? `${ds.host}/${ds.database_name}`
    : `${ds.host}:${ds.port}/${ds.database_name}`
  const secretLabel = isBigQuery ? 'Service account key set' : 'Password set'

  return (
    // A card in the page, on the page's surface (DS-10): --bg-elevated is for
    // floating layers now. The one card radius (DS-24).
    <div
      className="flex flex-col overflow-hidden rounded-card border transition-colors hover:border-[var(--border-strong)]"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-start gap-3 p-3.5">
        <div
          // Sans: mono is never set bold (DS-17).
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-micro font-bold uppercase"
          style={{
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            letterSpacing: '0.04em',
          }}
        >
          {ds.db_type.slice(0, 2)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-body font-semibold">{ds.name}</span>
          </div>
          {!connectionRedacted && (
            <div
              className="mono mt-0.5 truncate text-caption"
              style={{ color: 'var(--fg-subtle)' }}
              title={connectionLabel}
            >
              {connectionLabel}
            </div>
          )}
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
        {!hasTestRow && (
          <Chip tone={statusTone} size="xs">
            {statusLabel}
          </Chip>
        )}
        {ds.is_synthetic ? <SyntheticSourceBadge /> : <Chip size="xs">{ds.db_type}</Chip>}
        {ds.username && <Chip size="xs">{ds.username}</Chip>}
        {ds.timeout_seconds != null && <Chip size="xs">timeout {ds.timeout_seconds}s</Chip>}
        <div className="flex-1" />
        {/* A relative time is not code: sans + tabular digits (DS-17). */}
        <span className="tnum text-micro" style={{ color: 'var(--fg-faint)' }}>
          {formatRelativeTime(ds.updated_at)}
        </span>
      </div>

      {hasTestRow && (
        <div
          className="border-t text-caption"
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
            <span className="shrink-0 font-semibold">{statusLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate" title={stale ? ds.last_test_message ?? undefined : undefined}>
              {stale && lastTestAt ? `Last checked ${formatDate(lastTestAt)}` : ds.last_test_message}
            </span>
            {lastTestAt && (
              <span
                className="tnum ml-auto shrink-0 text-micro"
                style={{ color: 'var(--fg-faint)' }}
              >
                {stale ? 're-test to confirm' : formatRelativeTime(lastTestAt)}
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

      {deleteError && (
        <p
          role="alert"
          className="border-t px-3.5 py-2 text-caption"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--danger)', background: 'var(--danger-soft)' }}
        >
          Could not delete {ds.name}: {deleteError}
        </p>
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
          <IconButton
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            label={`Delete data source ${ds.name}`}
          >
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  )
}
