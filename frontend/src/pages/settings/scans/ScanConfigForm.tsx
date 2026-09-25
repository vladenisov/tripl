import { PageHeader } from '@/components/primitives/page-header'
import { PageContainer } from '@/components/primitives/page-container'
import { SaveBar } from '@/components/forms/SaveBar'
import { SCard } from '@/components/settings/kit'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useConfirm } from '@/hooks/useConfirm'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useProjectDataSources } from '@/hooks/useProjectDataSources'
import type { EventType, ScanConfig } from '@/types'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/error-state'
import { ReplayDialog } from './ReplayDialog'
import {
  AppVersionSection,
  EventNamingSection,
  LimitsSection,
  MetricsDriftSection,
  ScanEssentialsSection,
} from './ScanFormSections'
import { scanFormBlocker, useScanForm, type ScanFormPayload } from './useScanForm'
import { eventTypesKey, platformPresenceKey, scanJobsKey, scansKey } from '@/lib/queryKeys'
import { ownerOnlyReason, useIsOwner } from '@/lib/permissions'
import { ReadOnlyNotice } from '@/components/read-only-notice'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'

// ─── Configuration tab (page-style edit, one Save for the whole form) ───
export function ScanConfigurationTab({
  slug,
  scanConfig,
  onDeleted,
  onDirtyChange,
}: {
  slug: string
  scanConfig: ScanConfig
  onDeleted: () => void
  /**
   * Told whether the form holds unsaved edits, and `false` once it unmounts.
   * The page owns the leave guard: it also has to ask before its own tab strip
   * unmounts this form (DATA-12), which no guard in here can see.
   */
  onDirtyChange?: (dirty: boolean) => void
}) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const { confirm, dialog } = useConfirm()
  const [replayOpen, setReplayOpen] = useState(false)
  const form = useScanForm(slug, scanConfig)
  // Update, preview, replay and delete are all OwnerUserDep: anyone else reads
  // the configuration with every control disabled and no Save (DATA-6).
  const canEdit = useIsOwner()

  const { data: dataSources = [] } = useProjectDataSources()
  const { data: eventTypes = [] } = useQuery({
    queryKey: eventTypesKey(slug, null),
    queryFn: () => eventTypesApi.list(slug, null),
  })

  // What a Save would send, against what the last save (or the page load) sent.
  const payloadSnapshot = JSON.stringify(form.toBackendPayload())
  const [savedSnapshot, setSavedSnapshot] = useState(payloadSnapshot)
  // A non-owner's form is disabled and so never dirty.
  const dirty = canEdit && payloadSnapshot !== savedSnapshot
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  // The payload travels as the mutation's variables so the saved snapshot is
  // the one this request SENT, not whatever the form holds when it answers
  // (an edit typed while the save was in flight must stay dirty).
  const updateMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (payload: ScanFormPayload) => scansApi.update(slug, scanConfig.id, payload),
    onSuccess: (_saved, payload) => {
      setSavedSnapshot(JSON.stringify(payload))
      return qc.invalidateQueries({ queryKey: scansKey(slug) })
    },
  })

  const deleteMut = useMutation({
    // Rendered inline in the Danger zone, next to the button that failed.
    meta: SILENT_ERROR_META,
    mutationFn: () => scansApi.del(slug, scanConfig.id),
    onSuccess: () => {
      // The list mounts from cache (staleTime 60s), so without this the deleted
      // scan was still listed there with a Run now that 404s (DATA-4). Drop it
      // from the cache now, then refetch for anything else that changed.
      qc.setQueryData<ScanConfig[]>(scansKey(slug), current =>
        current?.filter(config => config.id !== scanConfig.id),
      )
      qc.removeQueries({ queryKey: scanJobsKey(slug, scanConfig.id) })
      qc.removeQueries({ queryKey: platformPresenceKey(slug, scanConfig.id) })
      void qc.invalidateQueries({ queryKey: scansKey(slug) })
      onDeleted()
    },
  })

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete scan',
      message: `Delete "${scanConfig.name}"? Stops adding events from this query. Events already in your plan are kept.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  const canReplay = Boolean(scanConfig.time_column && scanConfig.interval)

  // The reason, not just the fact: a disabled Save with no explanation is how a
  // user ends up believing the form is broken.
  const saveBlocker = scanFormBlocker(form.state)

  // "Saved." only while the form still holds what was saved: it used to stay up
  // after further edits, under every card at once (DATA-14).
  const saveStatus = updateMut.isPending
    ? ''
    : dirty
      ? 'Unsaved changes.'
      : updateMut.isSuccess
        ? 'Saved.'
        : ''

  const sectionProps = {
    form,
    slug,
    branchId,
    dataSources,
    eventTypes: eventTypes as EventType[],
    sourceLocked: true,
    readOnly: !canEdit,
  }

  return (
    <div className="flex flex-col">
      {dialog}
      {updateMut.isError && (
        <div className="mb-5">
          <ErrorState compact title="Could not save scan" error={updateMut.error} />
        </div>
      )}
      {!canEdit && (
        <ReadOnlyNotice className="mb-5">
          {ownerOnlyReason('change, replay or delete a scan')}
        </ReadOnlyNotice>
      )}
      {/* `disabled` on a fieldset reaches every native control inside it;
          `contents` keeps it out of the layout. */}
      <fieldset disabled={!canEdit} className="contents">
        <ScanEssentialsSection {...sectionProps} />
        <EventNamingSection {...sectionProps} />
        <AppVersionSection {...sectionProps} />
        <MetricsDriftSection {...sectionProps} />
        <LimitsSection {...sectionProps} />
      </fieldset>

      {/* One Save for the whole form. Every card used to carry its own, which
          read as "save this card" while each one sent the entire form — so
          Save under Limits also committed a half-edited query two cards up
          (DATA-14). Sticky, so it is in reach from whichever card was edited. */}
      {canEdit && (
        <SaveBar className="mb-5" status={saveStatus}>
          <Button
            type="button"
            size="sm"
            onClick={() => updateMut.mutate(form.toBackendPayload())}
            disabled={updateMut.isPending || !dirty || saveBlocker !== null}
            title={saveBlocker ?? undefined}
          >
            {updateMut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </SaveBar>
      )}

      {canEdit && (
        <SCard title="Danger zone" tone="danger">
          <div
            className="flex items-center gap-[18px] border-b px-4 py-3.5"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <div className="flex-1">
              <div className="text-body font-medium" style={{ color: 'var(--fg)' }}>
                Run a one-off replay
              </div>
              <div className="mt-0.5 text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
                Re-scan a historical time range into events and metrics.
              </div>
            </div>
            <Button
              type="button"
              variant={replayOpen ? 'default' : 'outline'}
              size="sm"
              disabled={!canReplay}
              title={canReplay ? 'Replay metrics for a past period' : 'Requires time column and interval'}
              onClick={() => setReplayOpen((o) => !o)}
            >
              <RotateCcw className="size-3" />
              Replay…
            </Button>
          </div>
          {replayOpen && (
            <div className="border-b px-4 py-3.5" style={{ borderColor: 'var(--border-subtle)' }}>
              <ReplayDialog slug={slug} scanConfig={scanConfig} open={replayOpen} onOpenChange={setReplayOpen} />
            </div>
          )}
          <div className="flex items-center gap-[18px] px-4 py-3.5">
            <div className="flex-1">
              <div className="text-body font-medium" style={{ color: 'var(--fg)' }}>
                Delete scan
              </div>
              <div className="mt-0.5 text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
                Stops adding events from this query. Events already in your plan are kept.
              </div>
            </div>
            {/* Bare red in a row; the solid red is the confirm dialog's (DS-20). */}
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={deleteMut.isPending}
              onClick={handleDelete}
            >
              <Trash2 className="size-3" />
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
          {deleteMut.isError && (
            <div className="px-4 pb-3.5">
              <ErrorState compact title="Could not delete scan" error={deleteMut.error} />
            </div>
          )}
        </SCard>
      )}
    </div>
  )
}

// ─── New scan — full page at /p/:slug/scans/new (no dialog) ───
export function ScanCreatePage({
  slug,
  onBack,
  onCreated,
}: {
  slug: string
  onBack: () => void
  /** Where to go once the scan exists: its own page, where Run now lives. */
  onCreated: (created: ScanConfig) => void
}) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const form = useScanForm(slug, null)
  // A typed SQL query and its group rules used to vanish on Back or a reload,
  // with no route to come back to and nothing asking first (DATA-13).
  const [initialSnapshot] = useState(() => JSON.stringify(form.state))
  const unsaved = useUnsavedChangesGuard(JSON.stringify(form.state) !== initialSnapshot)

  const { data: dataSources = [] } = useProjectDataSources()
  const { data: eventTypes = [] } = useQuery({
    queryKey: eventTypesKey(slug, null),
    queryFn: () => eventTypesApi.list(slug, null),
  })

  const createMut = useMutation({
    // Rendered inline below as "Could not create scan".
    meta: SILENT_ERROR_META,
    mutationFn: () =>
      scansApi.create(slug, {
        data_source_id: form.state.dataSourceId,
        ...form.toBackendPayload(),
      }),
    onSuccess: created => {
      qc.invalidateQueries({ queryKey: scansKey(slug) })
      unsaved.release()
      onCreated(created)
    },
  })

  const loaded = Boolean(form.preview)
  const createBlocker = scanFormBlocker(form.state)

  const sectionProps = {
    form,
    slug,
    branchId,
    dataSources,
    eventTypes: eventTypes as EventType[],
    sourceLocked: false,
  }

  return (
    <PageContainer width="narrow" className="space-y-0">
      {unsaved.dialog}
      {/* "…to ingest events and roll up metrics" promised monitoring before the
          user had chosen it, and read as a contradiction with Catalog only two
          lines below. What the scan does is now the first question, and the note
          under the radio answers it, so this line only has to say what you are
          pointing at what. */}
      <PageHeader
        className="mb-[18px]"
        eyebrow="Govern · Scan"
        title="New scan"
        description="Point a warehouse query at tripl, and choose what it does with the rows."
        back={
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 text-caption"
            style={{ color: 'var(--fg-muted)' }}
          >
            <span aria-hidden>←</span> Scans
          </button>
        }
      />

      <ScanEssentialsSection {...sectionProps} />
      <EventNamingSection {...sectionProps} />
      <AppVersionSection {...sectionProps} />
      <MetricsDriftSection {...sectionProps} />
      <LimitsSection {...sectionProps} />

      {createMut.isError && (
        <div className="mb-5">
          <ErrorState compact title="Could not create scan" error={createMut.error} />
        </div>
      )}

      {/* Sticky, like the edit form's bar: Create sat under five cards and was
          a full scroll away from the query at the top (AU-6 / MT-4). */}
      <SaveBar
        status={
          // In Catalog + monitoring the preview is not optional: the time column
          // is chosen from the columns it returns. In Catalog only it is not
          // "optional" either any more — it is how you find out what this scan
          // would put in your plan before you create it (tripl-3y7z.6).
          loaded
            ? 'Creates the scan. Run it from its page when you are ready.'
            : form.state.mode === 'monitoring'
              ? 'Load a preview to choose a time column and see what this scan would create.'
              : 'Load a preview to see what this scan would create.'
        }
      >
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={createBlocker !== null || createMut.isPending}
          title={createBlocker ?? undefined}
          onClick={() => createMut.mutate()}
        >
          <Plus className="size-3.5" />
          {createMut.isPending ? 'Creating…' : 'Create scan'}
        </Button>
      </SaveBar>
    </PageContainer>
  )
}
