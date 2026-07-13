import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, RotateCcw, Save, Trash2, TriangleAlert } from 'lucide-react'
import {
  projectsApi,
  type AnomalyResetCounts,
  type DetectionResetPeriod,
  type DriftResetCounts,
} from '@/api/projects'
import { searchApi } from '@/api/search'
import { useAuth } from '@/components/auth-context'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/hooks/useConfirm'
import { getErrorMessage } from '@/lib/utils'
import {
  Field,
  SCard,
  Select,
  SHeader,
  TextArea,
  TextInput,
} from '@/components/settings/kit'

function DangerRow({
  title,
  hint,
  action,
  last,
}: {
  title: string
  hint: string
  action: ReactNode
  last?: boolean
}) {
  return (
    <div
      className="flex items-center gap-[18px] px-[18px] py-[14px]"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
          {hint}
        </div>
      </div>
      {action}
    </div>
  )
}

/** Danger-zone reset windows. Each maps to a `before` cutoff (older rows go). */
const RESET_PERIODS: { value: string; label: string; days: number | null }[] = [
  { value: '7d', label: 'Older than 7 days', days: 7 },
  { value: '30d', label: 'Older than 30 days', days: 30 },
  { value: '90d', label: 'Older than 90 days', days: 90 },
  { value: 'all', label: 'All time', days: null },
]

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_APP_VERSION_KEEP_RELEASES = 100

// Query prefixes refreshed after a reset so the cleared state is reflected
// everywhere the deleted detections (and their derived signals) surface.
const ANOMALY_INVALIDATE_KEYS: readonly (readonly string[])[] = [
  ['anomalies'],
  ['metrics-catalog'],
  ['overview'],
  ['activeSignals'],
  ['monitoringMetrics'],
  ['project'],
  ['projects'],
]
const DRIFT_INVALIDATE_KEYS: readonly (readonly string[])[] = [
  ['eventTypeDrifts'],
  ['distributionDrifts'],
  ['eventTypes'],
  ['events'],
  ['project'],
  ['projects'],
]

function resetPeriodPayload(value: string): DetectionResetPeriod {
  const option = RESET_PERIODS.find((period) => period.value === value)
  if (!option || option.days === null) return { before: null, after: null }
  return { before: new Date(Date.now() - option.days * DAY_MS).toISOString(), after: null }
}

function periodLabel(value: string): string {
  return (RESET_PERIODS.find((period) => period.value === value)?.label ?? 'All time').toLowerCase()
}

function summarizeAnomalyCounts(counts: AnomalyResetCounts): string {
  return `Cleared ${counts.metric_anomalies} anomalies and ${counts.metric_breakdown_anomalies} breakdown anomalies.`
}

function summarizeDriftCounts(counts: DriftResetCounts): string {
  return `Cleared ${counts.schema_drifts} schema drifts and ${counts.distribution_drifts} distribution drifts.`
}

/**
 * A danger-zone row that clears a category of detections over a chosen period.
 * The period selector sits next to a destructive button; confirmation and the
 * mutation are owned by the caller. Feedback (counts / error) renders under it.
 */
function DangerResetRow({
  title,
  hint,
  buttonLabel,
  period,
  onPeriodChange,
  onReset,
  busy,
  feedback,
}: {
  title: string
  hint: string
  buttonLabel: string
  period: string
  onPeriodChange: (value: string) => void
  onReset: () => void
  busy: boolean
  feedback: ReactNode
}) {
  return (
    <div
      className="flex items-center gap-[18px] px-[18px] py-[14px]"
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
          {hint}
        </div>
        {feedback}
      </div>
      <div className="flex items-center gap-2">
        <Select
          aria-label={`${title} period`}
          value={period}
          onChange={onPeriodChange}
          options={RESET_PERIODS}
          disabled={busy}
        />
        <Button variant="destructive" size="sm" disabled={busy} onClick={onReset}>
          <RotateCcw className="h-3 w-3" />
          {busy ? 'Resetting…' : buttonLabel}
        </Button>
      </div>
    </div>
  )
}

/**
 * Project · General. Identity (name / slug / description) and the search-index
 * rebuild reuse the real projectsApi + searchApi wiring lifted from GeneralTab.
 * A header cross-link jumps to Project operations (the in-app /p/:slug/settings
 * surfaces) so the two project-config halves stay reachable, and the danger zone
 * keeps the wired Delete plus not-yet-wired Archive / Transfer actions.
 */
export default function ProjectGeneralSection({ slug }: { slug: string | undefined }) {
  if (!slug) {
    return (
      <div className="text-sm" style={{ color: 'var(--fg-subtle)' }}>
        Select a project to edit its settings.
      </div>
    )
  }
  return <ProjectGeneralBody slug={slug} />
}

function ProjectGeneralBody({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { confirm, dialog } = useConfirm()

  const projectQuery = useQuery({ queryKey: ['project', slug], queryFn: () => projectsApi.get(slug) })

  const [name, setName] = useState('')
  const [slugDraft, setSlugDraft] = useState('')
  const [description, setDescription] = useState('')
  const [appVersionKeepReleases, setAppVersionKeepReleases] = useState('')
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)

  if (projectQuery.data && hydratedFor !== projectQuery.data.id) {
    setName(projectQuery.data.name)
    setSlugDraft(projectQuery.data.slug)
    setDescription(projectQuery.data.description ?? '')
    setAppVersionKeepReleases(String(projectQuery.data.app_version_keep_releases))
    setHydratedFor(projectQuery.data.id)
  }

  const updateMut = useMutation({
    mutationFn: () => projectsApi.update(slug, { name, slug: slugDraft, description }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['project'] })
      if (project.slug !== slug) {
        try {
          localStorage.setItem('tripl-last-project-slug', project.slug)
        } catch {
          /* ignore */
        }
      }
    },
  })
  const reindexMut = useMutation({
    mutationFn: () => searchApi.reindex(slug),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commandPaletteSearch'] }),
  })
  const versionPolicyMut = useMutation({
    mutationFn: () =>
      projectsApi.update(slug, {
        app_version_keep_releases: Number(appVersionKeepReleases),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['project'] })
    },
  })
  const deleteMut = useMutation({
    mutationFn: () => projectsApi.del(slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      navigate('/', { replace: true })
    },
  })

  const [anomaliesPeriod, setAnomaliesPeriod] = useState('30d')
  const [driftsPeriod, setDriftsPeriod] = useState('30d')

  const resetAnomaliesMut = useMutation({
    mutationFn: (period: DetectionResetPeriod) => projectsApi.resetAnomalies(slug, period),
    onSuccess: () => {
      for (const key of ANOMALY_INVALIDATE_KEYS) qc.invalidateQueries({ queryKey: key })
    },
  })
  const resetDriftsMut = useMutation({
    mutationFn: (period: DetectionResetPeriod) => projectsApi.resetDrifts(slug, period),
    onSuccess: () => {
      for (const key of DRIFT_INVALIDATE_KEYS) qc.invalidateQueries({ queryKey: key })
    },
  })

  const handleResetAnomalies = async () => {
    const ok = await confirm({
      title: 'Reset anomalies',
      message: `Permanently delete anomaly detections (${periodLabel(anomaliesPeriod)}) across this entire project — every scan and catalog metric. Monitoring signals derived from them are cleared too. This cannot be undone.`,
      confirmLabel: 'Reset anomalies',
      variant: 'danger',
    })
    if (ok) resetAnomaliesMut.mutate(resetPeriodPayload(anomaliesPeriod))
  }

  const handleResetDrifts = async () => {
    const ok = await confirm({
      title: 'Reset drifts',
      message: `Permanently delete schema and distribution drift detections (${periodLabel(driftsPeriod)}) across this entire project. This cannot be undone.`,
      confirmLabel: 'Reset drifts',
      variant: 'danger',
    })
    if (ok) resetDriftsMut.mutate(resetPeriodPayload(driftsPeriod))
  }

  const handleDelete = async () => {
    const projectName = projectQuery.data?.name ?? slug
    const ok = await confirm({
      title: 'Delete project',
      message: `Permanently delete "${projectName}"? All event types, events, fields, metrics, monitors, and history are removed. This cannot be undone.`,
      confirmLabel: 'Delete project',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  const slugError = !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugDraft)
    ? 'Slug must be lowercase letters, digits, and hyphens'
    : null
  const isPristine =
    !!projectQuery.data &&
    name === projectQuery.data.name &&
    slugDraft === projectQuery.data.slug &&
    description === (projectQuery.data.description ?? '')
  const canEdit = user?.role === 'owner' || user?.role === 'editor'
  const canDelete = user?.role === 'owner'
  const appVersionKeepReleasesNumber = Number(appVersionKeepReleases)
  const versionPolicyInvalid =
    !Number.isInteger(appVersionKeepReleasesNumber) ||
    appVersionKeepReleasesNumber < 1 ||
    appVersionKeepReleasesNumber > MAX_APP_VERSION_KEEP_RELEASES
  const versionPolicyPristine =
    appVersionKeepReleasesNumber === projectQuery.data?.app_version_keep_releases

  return (
    <div>
      {dialog}
      <SHeader
        title="General"
        description="Identity and configuration for this tracking plan. These apply to everyone working in the project."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/p/${slug}/settings/event-types`)}
            >
              Project operations
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate(`/p/${slug}/events`)}>
              View project
            </Button>
          </>
        }
      />

      {projectQuery.isLoading && (
        <p className="text-sm" style={{ color: 'var(--fg-subtle)' }}>
          Loading project…
        </p>
      )}
      {projectQuery.isError && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          Failed to load project.
        </p>
      )}

      {projectQuery.data && (
        <>
          <SCard
            title="Project details"
            footer={
              <>
                <span className="flex-1 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                  {updateMut.isError ? getErrorMessage(updateMut.error) : ''}
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    if (!canEdit || slugError) return
                    updateMut.mutate()
                  }}
                  disabled={!canEdit || updateMut.isPending || isPristine || !!slugError}
                >
                  <Save className="h-3 w-3" />
                  {updateMut.isPending ? 'Saving…' : 'Save'}
                </Button>
              </>
            }
          >
            <Field label="Name" hint="Shown across the workspace and in the project switcher." htmlFor="proj-name">
              <TextInput id="proj-name" value={name} onChange={setName} disabled={!canEdit} />
            </Field>
            <Field
              label="Slug"
              hint={
                slugError && slugDraft.length > 0
                  ? slugError
                  : 'Used in URLs. Lowercase, digits and hyphens. Changing it rewrites project URLs.'
              }
              htmlFor="proj-slug"
            >
              <TextInput
                id="proj-slug"
                value={slugDraft}
                onChange={setSlugDraft}
                mono
                prefix="example.com/p/"
                disabled={!canEdit}
              />
            </Field>
            <Field label="Description" htmlFor="proj-desc" last>
              <TextArea id="proj-desc" value={description} onChange={setDescription} rows={2} disabled={!canEdit} />
            </Field>
          </SCard>

          <SCard
            title="Version monitoring"
            description="One release-retention policy for event monitoring and catalog metrics."
            footer={
              <>
                <span className="flex-1 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                  {versionPolicyMut.isError ? getErrorMessage(versionPolicyMut.error) : ''}
                </span>
                <Button
                  size="sm"
                  onClick={() => versionPolicyMut.mutate()}
                  disabled={
                    !canEdit ||
                    versionPolicyMut.isPending ||
                    versionPolicyInvalid ||
                    versionPolicyPristine
                  }
                >
                  <Save className="h-3 w-3" />
                  {versionPolicyMut.isPending ? 'Saving…' : 'Save'}
                </Button>
              </>
            }
          >
            <Field
              label="Releases to keep"
              hint={
                versionPolicyInvalid
                  ? `Enter a whole number from 1 to ${MAX_APP_VERSION_KEEP_RELEASES}.`
                  : 'Older releases are combined into Other across every app-version chart in this project.'
              }
              htmlFor="app-version-keep-releases"
              last
            >
              <TextInput
                id="app-version-keep-releases"
                type="number"
                value={appVersionKeepReleases}
                onChange={setAppVersionKeepReleases}
                disabled={!canEdit}
              />
            </Field>
          </SCard>

          <SCard title="Search index">
            <div className="flex items-center gap-[18px] px-[18px] py-[14px]">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium">Rebuild search index</div>
                <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
                  Rebuild project search when existing events, descriptions, or fields do not appear
                  in global search.
                </div>
                {reindexMut.isSuccess && (
                  <div className="mt-2 text-[12px]" style={{ color: 'var(--success)' }}>
                    Indexed {reindexMut.data.documents_indexed} documents
                    {reindexMut.data.embeddings_scheduled ? '; embeddings queued.' : '.'}
                  </div>
                )}
                {reindexMut.isError && (
                  <div className="mt-2 text-[12px]" style={{ color: 'var(--danger)' }}>
                    {getErrorMessage(reindexMut.error)}
                  </div>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => reindexMut.mutate()}
                disabled={!canEdit || reindexMut.isPending}
              >
                <RefreshCw className={reindexMut.isPending ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
                {reindexMut.isPending ? 'Rebuilding…' : 'Rebuild index'}
              </Button>
            </div>
          </SCard>

          <SCard title="Danger zone" tone="danger" icon={<TriangleAlert className="h-[15px] w-[15px]" />}>
            {canDelete && (
              <>
                <DangerResetRow
                  title="Reset anomalies"
                  hint="Delete anomaly detections (and the signals derived from them) across the whole project for the chosen period."
                  buttonLabel="Reset anomalies"
                  period={anomaliesPeriod}
                  onPeriodChange={setAnomaliesPeriod}
                  onReset={() => {
                    void handleResetAnomalies()
                  }}
                  busy={resetAnomaliesMut.isPending}
                  feedback={
                    resetAnomaliesMut.isSuccess ? (
                      <div className="mt-2 text-[12px]" style={{ color: 'var(--success)' }}>
                        {summarizeAnomalyCounts(resetAnomaliesMut.data)}
                      </div>
                    ) : resetAnomaliesMut.isError ? (
                      <div className="mt-2 text-[12px]" style={{ color: 'var(--danger)' }}>
                        {getErrorMessage(resetAnomaliesMut.error)}
                      </div>
                    ) : null
                  }
                />
                <DangerResetRow
                  title="Reset drifts"
                  hint="Delete schema and distribution drift detections across the whole project for the chosen period."
                  buttonLabel="Reset drifts"
                  period={driftsPeriod}
                  onPeriodChange={setDriftsPeriod}
                  onReset={() => {
                    void handleResetDrifts()
                  }}
                  busy={resetDriftsMut.isPending}
                  feedback={
                    resetDriftsMut.isSuccess ? (
                      <div className="mt-2 text-[12px]" style={{ color: 'var(--success)' }}>
                        {summarizeDriftCounts(resetDriftsMut.data)}
                      </div>
                    ) : resetDriftsMut.isError ? (
                      <div className="mt-2 text-[12px]" style={{ color: 'var(--danger)' }}>
                        {getErrorMessage(resetDriftsMut.error)}
                      </div>
                    ) : null
                  }
                />
              </>
            )}
            <DangerRow
              title="Archive project"
              hint="Hide from the workspace and stop ingesting. Reversible."
              action={
                <Button variant="outline" size="sm" disabled>
                  Archive
                </Button>
              }
            />
            <DangerRow
              title="Transfer ownership"
              hint="Move this project to another workspace member."
              action={
                <Button variant="outline" size="sm" disabled>
                  Transfer
                </Button>
              }
            />
            <DangerRow
              title="Delete project"
              hint="Permanently remove the plan, history and all ingested events. Cannot be undone."
              last
              action={
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={!canDelete || deleteMut.isPending}
                  onClick={() => {
                    void handleDelete()
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                  {deleteMut.isPending ? 'Deleting…' : 'Delete project'}
                </Button>
              }
            />
          </SCard>
        </>
      )}
    </div>
  )
}
