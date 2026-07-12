import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Play, Sliders } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useAdaptiveRefetchIntervalFn } from '@/realtime/streamContext'
import { scanJobsHaveActiveWork } from './scans/scanUtils'
import type { DataSource, ScanConfig, ScanJob } from '@/types'
import { Button } from '@/components/ui/button'
import { Dot } from '@/components/primitives/dot'
import { ErrorState } from '@/components/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { getErrorMessage } from '@/lib/utils'
import { ScanDetail } from './ScanDetail'
import { ScanConfigurationTab } from './scans/ScanConfigForm'
import { ScanBadges } from './scans/ScanConfigRow'
import { BackLink, SrcIcon } from './scans/scanLayout'
import { INTERVAL_LABEL, STATUS_META } from './scans/scanLayoutConstants'
import { deriveScanRunInfo } from './scans/scanUtils'

type DetailTab = 'overview' | 'configuration'

export function ScanConfigDetail({ slug, scanConfigId }: { slug: string; scanConfigId: string }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const { notifyScanRunStarted } = useDemoScenarioActions()
  const [tab, setTab] = useState<DetailTab>('overview')

  const {
    data: scanConfigs = [],
    isSuccess: scansLoaded,
    isError: scansError,
    error: scansErrorObj,
    refetch: refetchScans,
  } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })
  const { data: dataSources = [] } = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => dataSourcesApi.list(),
  })
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const sc = scanConfigs.find(s => s.id === scanConfigId)

  const jobsRefetchInterval = useAdaptiveRefetchIntervalFn<ScanJob[]>({
    activeMs: 5000,
    isActive: scanJobsHaveActiveWork,
  })
  const { data: jobs = [] } = useQuery({
    queryKey: ['scanJobs', slug, scanConfigId],
    queryFn: () => scansApi.listJobs(slug, scanConfigId),
    refetchInterval: jobsRefetchInterval,
    enabled: !!sc,
  })

  const runMut = useMutation({
    mutationFn: () => scansApi.run(slug, scanConfigId),
    onSuccess: (job) => {
      // The demo's runtime tick manufactures scan jobs continuously, so only the
      // job *this* POST returned can advance the coached scenario. Inert outside
      // a demo project (tripl-2su6.21.5).
      notifyScanRunStarted(job)
      qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfigId] })
    },
  })

  const goBack = () => navigate(`/p/${slug}/settings/scans`)

  // Loading the config list errored — surface it with a retry instead of a
  // blank screen (tripl-2su6.9).
  if (scansError) {
    return (
      <div className="space-y-4">
        <BackLink onClick={goBack} />
        <ErrorState
          compact
          title="Couldn't load this scan"
          error={scansErrorObj}
          onRetry={() => {
            void refetchScans()
          }}
        />
      </div>
    )
  }
  if (scansLoaded && !sc) {
    return (
      <div className="space-y-4">
        <BackLink onClick={goBack} />
        <p className="text-sm text-muted-foreground">Scan config not found.</p>
      </div>
    )
  }
  // Still loading — a skeleton, never a blank render (tripl-2su6.9).
  if (!sc) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading scan config">
        <BackLink onClick={goBack} />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const dataSource = (dataSources as DataSource[]).find(ds => ds.id === sc.data_source_id) ?? null
  const runInfo = deriveScanRunInfo(jobs)
  const meta = STATUS_META[runInfo.status]

  return (
    <div className="flex flex-col gap-4">
      <BackLink onClick={goBack} />

      <div className="flex items-start gap-3">
        <SrcIcon dbType={dataSource?.db_type ?? null} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="m-0 text-[21px] font-semibold tracking-tight">{sc.name}</h1>
            <span className="inline-flex items-center gap-1.5">
              <Dot tone={meta.tone} pulse={runInfo.status === 'running'} size={6} />
              <span className="text-xs" style={{ color: `var(--${meta.tone === 'neutral' ? 'fg-subtle' : meta.tone})` }}>
                {meta.label}
              </span>
            </span>
          </div>
          <p className="mt-1 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            Ingests from <span style={{ color: 'var(--fg-muted)' }}>{dataSource?.name ?? 'Unknown source'}</span>
          </p>
        </div>
        <ScenarioCoachMark step="run-scan" side="bottom" align="end">
          <Button variant="secondary" size="sm" disabled={runMut.isPending} onClick={() => runMut.mutate()}>
            <Play className="size-3" />
            {runMut.isPending ? 'Starting…' : 'Run now'}
          </Button>
        </ScenarioCoachMark>
        <Button
          variant={tab === 'configuration' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setTab('configuration')}
        >
          <Sliders className="size-3.5" />
          Edit
        </Button>
      </div>

      {runMut.isError && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>{getErrorMessage(runMut.error)}</p>
      )}

      <ScanBadges sc={sc} intervalLabel={INTERVAL_LABEL} />

      <div role="tablist" aria-label="Scan detail sections" className="flex gap-1 border-b" style={{ borderColor: 'var(--border)' }}>
        {(['overview', 'configuration'] as const).map((id, idx, arr) => (
          <button
            key={id}
            id={`scan-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`scan-tabpanel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            type="button"
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') {
                const next = arr[(idx + 1) % arr.length]
                setTab(next)
                document.getElementById(`scan-tab-${next}`)?.focus()
              } else if (e.key === 'ArrowLeft') {
                const prev = arr[(idx - 1 + arr.length) % arr.length]
                setTab(prev)
                document.getElementById(`scan-tab-${prev}`)?.focus()
              }
            }}
            className="-mb-px px-3 py-2 text-[12.5px] font-medium"
            style={{
              color: tab === id ? 'var(--fg)' : 'var(--fg-muted)',
              borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {id === 'overview' ? 'Overview' : 'Configuration'}
          </button>
        ))}
      </div>

      {tab === 'overview' ? (
        <div id="scan-tabpanel-overview" role="tabpanel" aria-labelledby="scan-tab-overview">
          <ScanDetail
            slug={slug}
            scanConfig={sc as ScanConfig}
            eventTypes={eventTypes}
            branchId={branchId}
            dataSource={dataSource}
          />
        </div>
      ) : (
        <div id="scan-tabpanel-configuration" role="tabpanel" aria-labelledby="scan-tab-configuration">
          <ScanConfigurationTab slug={slug} scanConfig={sc as ScanConfig} onDeleted={goBack} />
        </div>
      )}
    </div>
  )
}
