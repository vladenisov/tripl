import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RotateCcw, Trash2 } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useConfirm } from '@/hooks/useConfirm'
import type { DataSource, EventType, ScanConfig } from '@/types'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/error-state'
import { ReplayDialog } from './ReplayDialog'
import { SCard } from './scanLayout'
import {
  AppVersionSection,
  EventNamingSection,
  LimitsSection,
  MetricsDriftSection,
  ScanEssentialsSection,
} from './ScanFormSections'
import { MONITORING_INCOMPLETE_TITLE, canSubmitScanForm, useScanForm } from './useScanForm'
import { dataSourcesKey } from '@/lib/queryKeys'

// ─── Configuration tab (page-style edit, each SCard has its own Save footer) ───
export function ScanConfigurationTab({
  slug,
  scanConfig,
  onDeleted,
}: {
  slug: string
  scanConfig: ScanConfig
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const { confirm, dialog } = useConfirm()
  const [replayOpen, setReplayOpen] = useState(false)
  const form = useScanForm(slug, scanConfig)

  const { data: dataSources = [] } = useQuery({
    queryKey: dataSourcesKey(),
    queryFn: () => dataSourcesApi.list(),
  })
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const updateMut = useMutation({
    mutationFn: () => scansApi.update(slug, scanConfig.id, form.toBackendPayload()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scans', slug] }),
  })

  const deleteMut = useMutation({
    mutationFn: () => scansApi.del(slug, scanConfig.id),
    onSuccess: onDeleted,
  })

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete scan config',
      message: `Delete "${scanConfig.name}"? Stops ingestion from this query. Ingested events are kept.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  const canReplay = Boolean(scanConfig.time_column && scanConfig.interval)

  const canSave = canSubmitScanForm(form.state)

  const footerFor = () => (
    <>
      <span role="status" className="flex-1 text-xs" style={{ color: 'var(--fg-subtle)' }}>
        {updateMut.isError ? '' : updateMut.isSuccess ? 'Saved.' : ''}
      </span>
      <Button
        type="button"
        size="sm"
        onClick={() => updateMut.mutate()}
        disabled={updateMut.isPending || !canSave}
        title={canSave ? undefined : MONITORING_INCOMPLETE_TITLE}
      >
        {updateMut.isPending ? 'Saving…' : 'Save'}
      </Button>
    </>
  )

  const sectionProps = {
    form,
    slug,
    branchId,
    dataSources: dataSources as DataSource[],
    eventTypes: eventTypes as EventType[],
    sourceLocked: true,
    footerFor,
  }

  return (
    <div className="flex flex-col">
      {dialog}
      {updateMut.isError && (
        <div className="mb-5">
          <ErrorState compact title="Could not save scan config" error={updateMut.error} />
        </div>
      )}
      <ScanEssentialsSection {...sectionProps} />
      <EventNamingSection {...sectionProps} />
      <AppVersionSection {...sectionProps} />
      <MetricsDriftSection {...sectionProps} />
      <LimitsSection {...sectionProps} />

      <SCard title="Danger zone" tone="danger">
        <div
          className="flex items-center gap-[18px] border-b px-[18px] py-3.5"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex-1">
            <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
              Run a one-off replay
            </div>
            <div className="mt-0.5 text-xs" style={{ color: 'var(--fg-subtle)' }}>
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
          <div className="border-b px-[18px] py-3.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <ReplayDialog slug={slug} scanConfig={scanConfig} open={replayOpen} onOpenChange={setReplayOpen} />
          </div>
        )}
        <div className="flex items-center gap-[18px] px-[18px] py-3.5">
          <div className="flex-1">
            <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
              Delete scan config
            </div>
            <div className="mt-0.5 text-xs" style={{ color: 'var(--fg-subtle)' }}>
              Stops ingestion from this query. Ingested events are kept.
            </div>
          </div>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleteMut.isPending}
            onClick={handleDelete}
          >
            <Trash2 className="size-3" />
            Delete
          </Button>
        </div>
      </SCard>
    </div>
  )
}

// ─── New scan — full page (in-place view state, no route, no dialog) ───
export function ScanCreatePage({ slug, onBack }: { slug: string; onBack: () => void }) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const form = useScanForm(slug, null)

  const { data: dataSources = [] } = useQuery({
    queryKey: dataSourcesKey(),
    queryFn: () => dataSourcesApi.list(),
  })
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const createMut = useMutation({
    mutationFn: () =>
      scansApi.create(slug, {
        data_source_id: form.state.dataSourceId,
        ...form.toBackendPayload(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['scans', slug] })
      onBack()
    },
  })

  const loaded = Boolean(form.preview)
  const canCreate = canSubmitScanForm(form.state)

  const sectionProps = {
    form,
    slug,
    branchId,
    dataSources: dataSources as DataSource[],
    eventTypes: eventTypes as EventType[],
    sourceLocked: false,
    footerFor: undefined,
  }

  return (
    <div className="max-w-[880px] pb-12">
      <div className="mb-3.5">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-[11.5px]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <span aria-hidden>←</span> Scans
        </button>
      </div>
      <h1 className="m-0 mb-1 text-[19px] font-semibold tracking-tight">New scan config</h1>
      {/* "…to ingest events and roll up metrics" promised monitoring before the
          user had chosen it, and read as a contradiction with Catalog only two
          lines below. What the scan does is now the first question, and the note
          under the radio answers it — this line only says what you are pointing
          at what. */}
      <p className="mb-[18px] text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
        Point a warehouse query at tripl, and choose what it does with the rows.
      </p>

      <ScanEssentialsSection {...sectionProps} />
      <EventNamingSection {...sectionProps} />
      <AppVersionSection {...sectionProps} />
      <MetricsDriftSection {...sectionProps} />
      <LimitsSection {...sectionProps} />

      {createMut.isError && (
        <div className="mb-5">
          <ErrorState compact title="Could not create scan config" error={createMut.error} />
        </div>
      )}

      <div className="mt-1 flex items-center gap-2.5">
        <span className="flex-1 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
          {/* In Catalog + monitoring the preview is not optional: the time column
              is chosen from the columns it returns. In Catalog only it is not
              "optional" either any more — it is how you find out what this scan
              would put in your plan before you create it (tripl-3y7z.6). */}
          {loaded
            ? 'Creates the config and runs the first scan.'
            : form.state.mode === 'monitoring'
              ? 'Load a preview to choose a time column and see what this scan would create.'
              : 'Load a preview to see what this scan would create.'}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canCreate || createMut.isPending}
          title={canCreate ? undefined : MONITORING_INCOMPLETE_TITLE}
          onClick={() => createMut.mutate()}
        >
          <Plus className="size-3" />
          {createMut.isPending ? 'Creating…' : 'Create scan'}
        </Button>
      </div>
    </div>
  )
}
