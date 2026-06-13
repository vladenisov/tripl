import { type ElementType, type ReactNode, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { dataSourcesApi } from '@/api/dataSources'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useConfirm } from '@/hooks/useConfirm'
import { formatDate, formatDateTime } from '@/lib/datetime'
import { getMonitoringPath } from '@/lib/monitoring'
import type {
  Project,
  ProjectLatestScanJob,
  ProjectLatestSignal,
  ProjectSummary,
} from '@/types'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  BellRing,
  FolderKanban,
  PlayCircle,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react'

export default function MainPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const { confirm, dialog } = useConfirm()

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })
  const dataSourcesQuery = useQuery({
    queryKey: ['dataSources'],
    queryFn: dataSourcesApi.list,
  })

  const projects = [...(projectsQuery.data ?? [])].sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at),
  )
  const dataSourceCount = dataSourcesQuery.data?.length ?? 0

  const portfolio = projects.reduce(
    (totals, project) => {
      totals.activeEventCount += project.summary.active_event_count
      totals.alertDestinationCount += project.summary.alert_destination_count
      totals.eventCount += project.summary.event_count
      totals.implementedEventCount += project.summary.implemented_event_count
      totals.monitoringSignalCount += project.summary.monitoring_signal_count
      totals.projectCount += 1
      totals.reviewPendingEventCount += project.summary.review_pending_event_count
      totals.scanCount += project.summary.scan_count
      totals.variableCount += project.summary.variable_count
      return totals
    },
    {
      activeEventCount: 0,
      alertDestinationCount: 0,
      eventCount: 0,
      implementedEventCount: 0,
      monitoringSignalCount: 0,
      projectCount: 0,
      reviewPendingEventCount: 0,
      scanCount: 0,
      variableCount: 0,
    },
  )

  const coveragePercent = portfolio.activeEventCount
    ? Math.round((portfolio.implementedEventCount / portfolio.activeEventCount) * 100)
    : 0
  const projectsWithScans = projects.filter((project) => project.summary.scan_count > 0).length
  const projectsWithSignals = projects.filter(
    (project) => project.summary.monitoring_signal_count > 0,
  ).length
  const projectsNeedingReview = projects.filter(
    (project) => project.summary.review_pending_event_count > 0,
  ).length
  const projectsReady = projects.filter(
    (project) => getProjectStatus(project.summary).label === 'Ready',
  ).length
  const projectsWithLatestScanJob = projects.filter(
    (project) => project.summary.latest_scan_job != null,
  ).length
  const projectsWithRunningScan = projects.filter(
    (project) => project.summary.latest_scan_job?.status === 'running',
  ).length
  const projectsWithFailedScan = projects.filter(
    (project) => project.summary.latest_scan_job?.status === 'failed',
  ).length

  const createMut = useMutation({
    mutationFn: () => projectsApi.create({ name, slug, description }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setShowForm(false)
      setName('')
      setSlug('')
      setSlugTouched(false)
      setDescription('')
    },
  })

  const deleteMut = useMutation({
    mutationFn: (projectSlug: string) => projectsApi.del(projectSlug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const demoMut = useMutation({
    mutationFn: () => projectsApi.createDemo(),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      void navigate(`/p/${project.slug}/events`)
    },
  })

  const handleDelete = async (project: Project) => {
    const ok = await confirm({
      title: 'Delete project',
      message: `Are you sure you want to delete "${project.name}"? All event types and events will be permanently removed.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(project.slug)
  }

  const dataSourceValue = dataSourcesQuery.isError
    ? 'Unavailable'
    : dataSourcesQuery.isLoading
      ? '...'
      : String(dataSourceCount)
  const canCreateProject = user?.role === 'owner' || user?.role === 'editor'
  const canDeleteProject = user?.role === 'owner'

  return (
    <div className="space-y-6">
      {dialog}

      {/* Compact header */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0 space-y-2">
          <div className="flex items-baseline gap-2.5">
            <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">
              Analytics workspace
            </h1>
            <span className="mono text-[13px]" style={{ color: 'var(--fg-subtle)' }}>
              {portfolio.projectCount}
            </span>
          </div>
          <p className="max-w-2xl text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            See which tracking plans are filling out, which projects still need review, and how much
            scan and alerting coverage exists across the workspace.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <MiniStat label="Projects" value={String(portfolio.projectCount)} />
          <MiniStatDivider />
          <MiniStat
            label="Coverage"
            value={`${coveragePercent}%`}
            delta={portfolio.activeEventCount > 0 ? `${portfolio.implementedEventCount}/${portfolio.activeEventCount}` : undefined}
            tone={coveragePercent >= 80 ? 'success' : coveragePercent >= 50 ? 'warning' : 'neutral'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Signals"
            value={String(portfolio.monitoringSignalCount)}
            delta={portfolio.monitoringSignalCount > 0 ? 'live' : 'quiet'}
            tone={portfolio.monitoringSignalCount > 0 ? 'danger' : 'success'}
            pulse={portfolio.monitoringSignalCount > 0}
          />
          <MiniStatDivider />
          <MiniStat
            label="Data sources"
            value={dataSourceValue}
            tone={dataSourcesQuery.isError ? 'danger' : 'neutral'}
          />
          {canCreateProject && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => demoMut.mutate()}
                disabled={demoMut.isPending}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {demoMut.isPending ? 'Generating…' : 'Generate demo project'}
              </Button>
              <Button size="sm" onClick={() => setShowForm(true)}>
                <Plus className="h-3.5 w-3.5" />
                New project
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={(event) => { event.preventDefault(); createMut.mutate() }}>
            <DialogHeader>
              <DialogTitle>Create project</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    if (!slugTouched) {
                      setSlug(
                        event.target.value
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, '-')
                          .replace(/(^-|-$)/g, ''),
                      )
                    }
                  }}
                  placeholder="My Project"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="project-slug">Slug (url-friendly)</Label>
                <Input
                  id="project-slug"
                  value={slug}
                  onChange={(event) => {
                    setSlugTouched(true)
                    setSlug(event.target.value)
                  }}
                  className="font-mono"
                  pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="project-desc">Description (optional)</Label>
                <Textarea
                  id="project-desc"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={2}
                />
              </div>
              {createMut.isError && (
                <ErrorState compact title="Could not create project" error={createMut.error} />
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {projectsQuery.isLoading && <ProjectsPageSkeleton />}

      {projectsQuery.isError && (
        <ErrorState
          title="Failed to load projects"
          description="The page could not fetch projects from the backend."
          error={projectsQuery.error}
          onRetry={() => { void projectsQuery.refetch() }}
        />
      )}

      {!projectsQuery.isLoading && !projectsQuery.isError && (
        <>
          {/* Portfolio strip */}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <PortfolioCard
              icon={FolderKanban}
              label="Projects"
              value={String(portfolio.projectCount)}
              hint={
                portfolio.projectCount > 0
                  ? `${projectsReady} fully implemented`
                  : 'Create a project to start your catalog'
              }
            />
            <PortfolioCard
              icon={BadgeCheck}
              label="Coverage"
              value={`${coveragePercent}%`}
              hint={
                portfolio.activeEventCount > 0
                  ? `${portfolio.implementedEventCount} of ${portfolio.activeEventCount} active events`
                  : 'Coverage starts with your first active event'
              }
              tone={coveragePercent >= 80 ? 'success' : coveragePercent >= 50 ? 'warning' : 'neutral'}
            />
            <PortfolioCard
              icon={BellRing}
              label="Review queue"
              value={String(portfolio.reviewPendingEventCount)}
              hint={
                portfolio.reviewPendingEventCount > 0
                  ? `${projectsNeedingReview} projects need review`
                  : 'No pending event reviews'
              }
              tone={portfolio.reviewPendingEventCount > 0 ? 'warning' : 'success'}
            />
            <PortfolioCard
              icon={PlayCircle}
              label="Latest jobs"
              value={String(projectsWithLatestScanJob)}
              hint={
                projectsWithFailedScan > 0
                  ? `${projectsWithFailedScan} projects have a failed latest scan job`
                  : projectsWithRunningScan > 0
                    ? `${projectsWithRunningScan} projects are currently running scans`
                    : projectsWithLatestScanJob > 0
                      ? 'Latest scan jobs are healthy'
                      : 'No project has run a scan yet'
              }
              tone={projectsWithFailedScan > 0 ? 'danger' : projectsWithRunningScan > 0 ? 'info' : 'success'}
            />
          </div>

          <SignalsBanner
            scanCount={portfolio.scanCount}
            projectsWithScans={projectsWithScans}
            signalCount={portfolio.monitoringSignalCount}
            projectsWithSignals={projectsWithSignals}
          />

          {projects.length > 0 ? (
            <section className="space-y-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <h2 className="text-[14px] font-semibold tracking-tight">Project portfolio</h2>
                  <p className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                    Recently updated projects with planning, review, scan, and alerting coverage.
                  </p>
                </div>
                <Chip size="sm">{projects.length} tracked</Chip>
              </div>

              <div className="grid gap-3">
                {projects.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    canDelete={canDeleteProject}
                    onDelete={() => { void handleDelete(project) }}
                  />
                ))}
              </div>
            </section>
          ) : (
            <EmptyState
              icon={FolderKanban}
              title="No projects yet"
              description="Create your first project to start building a richer tracking-plan workspace with event coverage, scans, and monitoring."
              action={canCreateProject ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => demoMut.mutate()}
                    disabled={demoMut.isPending}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {demoMut.isPending ? 'Generating…' : 'Generate demo project'}
                  </Button>
                  <Button onClick={() => setShowForm(true)}>
                    <Plus className="h-3.5 w-3.5" />
                    New project
                  </Button>
                </div>
              ) : undefined}
            />
          )}
        </>
      )}
    </div>
  )
}

function ProjectsPageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-3">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-64 rounded-lg" />
        ))}
      </div>
    </div>
  )
}

type PortfolioTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

function PortfolioCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: ElementType
  label: string
  value: string
  hint: string
  tone?: PortfolioTone
}) {
  const toneColor =
    tone === 'success'
      ? 'var(--success)'
      : tone === 'warning'
        ? 'var(--warning)'
        : tone === 'danger'
          ? 'var(--danger)'
          : tone === 'info'
            ? 'var(--info)'
            : 'var(--accent)'
  const toneSoft =
    tone === 'success'
      ? 'var(--success-soft)'
      : tone === 'warning'
        ? 'var(--warning-soft)'
        : tone === 'danger'
          ? 'var(--danger-soft)'
          : tone === 'info'
            ? 'var(--info-soft)'
            : 'var(--accent-soft)'
  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: 'var(--fg-faint)' }}
          >
            {label}
          </p>
          <p className="mono tnum text-[24px] font-medium leading-[1.1] tracking-[-0.01em]">
            {value}
          </p>
        </div>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: toneSoft, color: toneColor }}
        >
          <Icon className="h-3.5 w-3.5" />
        </div>
      </div>
      <p className="mt-2 text-[11.5px] leading-[1.4]" style={{ color: 'var(--fg-subtle)' }}>
        {hint}
      </p>
    </div>
  )
}

function SignalsBanner({
  scanCount,
  projectsWithScans,
  signalCount,
  projectsWithSignals,
}: {
  scanCount: number
  projectsWithScans: number
  signalCount: number
  projectsWithSignals: number
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-5 rounded-lg border px-4 py-3"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          <Activity className="h-4 w-4" />
        </div>
        <div>
          <div className="text-[12.5px] font-semibold">Automation</div>
          <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            {scanCount > 0
              ? `${scanCount} scans · ${projectsWithScans} projects covered`
              : 'No scans configured yet'}
          </div>
        </div>
      </div>
      <div className="h-8 w-px" style={{ background: 'var(--border-subtle)' }} />
      <div className="flex items-center gap-2">
        <Dot tone={signalCount > 0 ? 'danger' : 'success'} pulse={signalCount > 0} size={8} />
        <div>
          <div className="text-[12.5px] font-semibold">
            {signalCount > 0 ? `${signalCount} monitoring signals` : 'No recent signals'}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            {signalCount > 0
              ? `${projectsWithSignals} projects currently have active or recent signals`
              : 'Monitoring is quiet across the workspace'}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProjectCard({
  project,
  canDelete,
  onDelete,
}: {
  project: Project
  canDelete: boolean
  onDelete: () => void
}) {
  const status = getProjectStatus(project.summary)
  const coverage = project.summary.active_event_count
    ? Math.round(
        (project.summary.implemented_event_count / project.summary.active_event_count) * 100,
      )
    : 0
  const hasSignals = project.summary.monitoring_signal_count > 0
  const needsReview = project.summary.review_pending_event_count > 0

  return (
    <Card
      className="overflow-hidden p-0"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
    >
      <div
        className="flex items-start justify-between gap-3 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{project.name}</span>
            <Chip
              tone={
                status.label === 'Ready'
                  ? 'success'
                  : status.label === 'Needs Review'
                    ? 'warning'
                    : status.label === 'In Progress'
                      ? 'info'
                      : 'neutral'
              }
              size="xs"
            >
              {status.label}
            </Chip>
            {hasSignals && (
              <Chip tone="danger" size="xs">
                <Dot tone="danger" pulse size={5} />
                live
              </Chip>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            {project.description ||
              'No project description yet. Add one to capture the scope of this tracking plan.'}
          </p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--fg-faint)' }}>
            <span className="mono">{project.slug}</span> · Updated {formatDate(project.updated_at)}
          </p>
        </div>
        {canDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            aria-label={`Delete ${project.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <CardContent className="space-y-4 px-4 py-4">
        <div className="flex flex-wrap gap-1.5">
          <Chip
            tone={coverage === 100 && project.summary.active_event_count > 0 ? 'success' : 'info'}
            size="xs"
          >
            {project.summary.active_event_count > 0 ? `${coverage}% implemented` : 'No active events'}
          </Chip>
          <Chip tone={needsReview ? 'warning' : 'neutral'} size="xs">
            {needsReview
              ? `${project.summary.review_pending_event_count} pending review`
              : 'Review queue clear'}
          </Chip>
          <Chip tone={project.summary.scan_count > 0 ? 'accent' : 'neutral'} size="xs">
            {project.summary.scan_count > 0
              ? `${project.summary.scan_count} scans configured`
              : 'No scan coverage'}
          </Chip>
          <Chip tone={hasSignals ? 'danger' : 'neutral'} size="xs">
            {hasSignals
              ? `${project.summary.monitoring_signal_count} recent signals`
              : 'No recent signals'}
          </Chip>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            <span>Implementation progress</span>
            <span className="mono tnum">
              {project.summary.implemented_event_count}/{project.summary.active_event_count || 0}
            </span>
          </div>
          <div
            className="h-1.5 overflow-hidden rounded-full"
            style={{ background: 'var(--bg-sunken)' }}
          >
            <div
              className="h-full rounded-full transition-[width]"
              style={{ width: `${coverage}%`, background: 'var(--accent)' }}
            />
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Event types" value={String(project.summary.event_type_count)} />
            <Metric label="Active events" value={String(project.summary.active_event_count)} />
            <Metric label="Variables" value={String(project.summary.variable_count)} />
            <Metric label="Alerts" value={String(project.summary.alert_destination_count)} />
          </div>
          <Panel icon={PlayCircle} title="Latest scan">
            <LatestScanJobSummary job={project.summary.latest_scan_job} />
          </Panel>
          <Panel icon={AlertTriangle} title="Monitoring">
            <LatestSignalSummary
              slug={project.slug}
              signal={project.summary.latest_signal}
              signalCount={project.summary.monitoring_signal_count}
            />
          </Panel>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to={`/p/${project.slug}/events`}>
              Open Project
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/p/${project.slug}/settings`}>
              <Settings2 className="h-3.5 w-3.5" />
              Settings
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-md border px-2.5 py-2"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
    >
      <p
        className="text-[10px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {label}
      </p>
      <p className="mono tnum mt-0.5 text-[18px] font-medium tracking-[-0.01em]">{value}</p>
    </div>
  )
}

function Panel({
  icon: Icon,
  title,
  children,
}: {
  icon: ElementType
  title: string
  children: ReactNode
}) {
  return (
    <div
      className="rounded-md border p-3"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        <div
          className="flex h-6 w-6 items-center justify-center rounded"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          <Icon className="h-3 w-3" />
        </div>
        <p className="text-[12px] font-medium">{title}</p>
      </div>
      {children}
    </div>
  )
}

function LatestScanJobSummary({ job }: { job: ProjectLatestScanJob | null }) {
  if (!job) {
    return (
      <div className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        No scan jobs have run yet. Configure a scan and run it once to start surfacing execution
        history here.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] font-medium">{job.scan_name}</p>
        <Badge variant={getScanJobStatusVariant(job.status)}>{job.status}</Badge>
      </div>
      <div className="space-y-0.5 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        <p>{describeScanJobTiming(job)}</p>
        {job.error_message && (
          <p className="line-clamp-2" style={{ color: 'var(--danger)' }}>
            {job.error_message}
          </p>
        )}
      </div>
      {job.result_summary && (
        <div className="flex flex-wrap gap-1.5">
          {job.result_summary.events_created != null && (
            <Chip size="xs" tone="success">
              +{job.result_summary.events_created} events
            </Chip>
          )}
          {job.result_summary.signals_added != null && job.result_summary.signals_added > 0 && (
            <Chip size="xs" tone="danger">
              +{job.result_summary.signals_added} signals
            </Chip>
          )}
          {job.result_summary.alerts_queued != null && job.result_summary.alerts_queued > 0 && (
            <Chip size="xs" tone="warning">
              +{job.result_summary.alerts_queued} alerts
            </Chip>
          )}
        </div>
      )}
    </div>
  )
}

function LatestSignalSummary({
  slug,
  signal,
  signalCount,
}: {
  slug: string
  signal: ProjectLatestSignal | null
  signalCount: number
}) {
  if (!signal) {
    return (
      <div className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        No active or recent monitoring signals. Once metrics collection finds anomalies, the latest
        signal will appear here.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={signal.state === 'recent' ? 'warning' : 'danger'} size="xs">
          {signal.state === 'recent' ? 'Recent signal' : 'Latest scan signal'}
        </Chip>
        <Chip tone={signal.direction === 'drop' ? 'warning' : 'danger'} size="xs">
          {signal.direction}
        </Chip>
        <Chip size="xs">{signalCount} active</Chip>
      </div>
      <div className="space-y-0.5">
        <p className="text-[12px] font-medium">{signal.scope_name}</p>
        <p className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
          {signal.actual_count.toLocaleString()} actual vs{' '}
          {Math.round(signal.expected_count).toLocaleString()} expected
        </p>
        <p className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>
          {formatDateTime(signal.bucket)} via {signal.scan_name}
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to={getMonitoringPath(slug, signal)}>
          Open Signal
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  )
}

function getProjectStatus(summary: ProjectSummary): {
  label: string
  variant: 'info' | 'warning' | 'success' | 'secondary'
} {
  if (summary.active_event_count === 0) {
    return { label: 'Setup', variant: 'secondary' }
  }
  if (summary.review_pending_event_count > 0) {
    return { label: 'Needs Review', variant: 'warning' }
  }
  if (summary.implemented_event_count === summary.active_event_count) {
    return { label: 'Ready', variant: 'success' }
  }
  return { label: 'In Progress', variant: 'info' }
}

function getScanJobStatusVariant(
  status: ProjectLatestScanJob['status'],
): 'outline' | 'secondary' | 'success' | 'destructive' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'running') return 'secondary'
  return 'outline'
}

function describeScanJobTiming(job: ProjectLatestScanJob) {
  if (job.started_at && job.completed_at) {
    return `Completed ${formatDateTime(job.completed_at)}`
  }
  if (job.started_at) {
    return `Started ${formatDateTime(job.started_at)}`
  }
  return `Queued ${formatDateTime(job.created_at)}`
}
