import { Suspense, useEffect, useState } from 'react'
import { lazyWithReload } from '@/lib/lazyWithReload'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { projectsQueryOptions } from '@/lib/queryKeys'
import { useAuth } from '@/components/auth-context'
import { ErrorState } from '@/components/error-state'
import { SCard } from '@/components/settings/kit'
import { SettingsLayout } from '@/components/settings/SettingsLayout'
import { SETTINGS_STORAGE_KEY } from '@/components/settings/nav'
import { LEAVE_CONFIRMED } from '@/components/settings/unsaved-changes'
import type { Project } from '@/types'
import { isOwner as isOwnerRole } from '@/lib/permissions'

const ProjectGeneralSection = lazyWithReload(() => import('./ProjectGeneralSection'))
const PlanRulesSection = lazyWithReload(() => import('./PlanRulesSection'))
const MembersSection = lazyWithReload(() => import('./MembersSection'))
const DataSourcesSection = lazyWithReload(() => import('./DataSourcesSection'))
const ApiKeysSection = lazyWithReload(() => import('./ApiKeysSection'))
const ProfileSection = lazyWithReload(() => import('./ProfileSection'))
const SecuritySection = lazyWithReload(() => import('./SecuritySection'))
const InstanceSection = lazyWithReload(() => import('./InstanceSection'))
const WorkspaceAuditSection = lazyWithReload(() => import('./WorkspaceAuditSection'))

const LAST_SLUG_STORAGE_KEY = 'tripl-last-project-slug'

/**
 * Resolve the project the Project-scoped settings target. Prefer the slug in the
 * URL — a route param, or the `?project=` every in-app link to these sections
 * carries — otherwise the last project visited. The last-visited key is shared
 * by every tab, so it is only the fallback for a bare address: reading it first
 * opened the OTHER tab's project, danger zone included (SHELL-20).
 * The sidebar's usePersistLastSlug writes the last-visited slug to this same
 * localStorage key on every project route; we only read it here.
 *
 * There is deliberately NO "first project" fallback: falling back to
 * `projects[0]` bound Settings to whichever project happened to sort first and
 * then offered to rename/delete it, one click after the workspace page said "no
 * project selected" (tripl-jfm3.32). With nothing chosen we return undefined
 * and the project sections ask the user to pick one.
 */
function useSettingsSlug(pickedSlug: string | null): string | undefined {
  const { slug: urlSlug } = useParams<{ slug?: string }>()
  const [searchParams] = useSearchParams()
  const queryProject = searchParams.get('project')
  const projectsQuery = useQuery(projectsQueryOptions())
  const projects = projectsQuery.data ?? []
  if (urlSlug) return urlSlug
  if (queryProject) return queryProject
  if (pickedSlug) return pickedSlug
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST_SLUG_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  if (last && projects.some((p) => p.slug === last)) return last
  return undefined
}

function SectionFallback() {
  return <div className="text-sm" style={{ color: 'var(--fg-subtle)' }}>Loading…</div>
}

/**
 * The full-takeover Settings area. A single page mounted at /settings/* routes;
 * it reads the active section from the URL, renders the matching config section
 * inside the takeover layout, persists the last section, and gates Instance
 * sections to owners.
 */
export default function SettingsArea({ section }: { section: string }) {
  const auth = useAuth()
  const isOwner = isOwnerRole(auth.user?.role)
  const [pickedSlug, setPickedSlug] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const slug = useSettingsSlug(pickedSlug)
  const projectsQuery = useQuery(projectsQueryOptions())
  const projects = projectsQuery.data ?? []
  const projectName = projects.find((p) => p.slug === slug)?.name

  // Picking a project from the empty state writes the same last-visited key the
  // sidebar maintains, so the choice survives a reload the way one made in the
  // app does.
  const pickProject = (picked: string) => {
    try {
      localStorage.setItem(LAST_SLUG_STORAGE_KEY, picked)
    } catch {
      /* ignore */
    }
    setPickedSlug(picked)
  }

  // A save that renames the project moves it to a new address. Every source the
  // slug came from has to follow, or the section goes on requesting the old
  // one: a picked slug outranked the localStorage key General had already
  // updated, so the page fell over with "Failed to load project" and any later
  // Save or Delete targeted a project that no longer existed (WS-8). The
  // address is rewritten in place; the draft is saved, so the leave guard has
  // nothing to ask about.
  const followRename = (renamed: string) => {
    setPickedSlug(renamed)
    if (searchParams.get('project') !== null) {
      const next = new URLSearchParams(searchParams)
      next.set('project', renamed)
      setSearchParams(next, { replace: true, state: LEAVE_CONFIRMED })
    }
  }

  // Persist the last visited section so re-entering /settings lands where the
  // user left off (the /settings index redirect reads this key).
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, section)
    } catch {
      /* ignore */
    }
  }, [section])

  const backHref = slug ? `/p/${slug}/events` : '/workspace'

  return (
    <SettingsLayout
      activePath={section}
      backHref={backHref}
      projectName={projectName}
      projectSlug={slug}
      projects={projects}
    >
      {/* The projects list is silent app-wide (lib/queryKeys.ts): inside the
          app shell Layout reports its failure. These routes mount outside
          Layout, so they report it here — once, and not where the no-project
          card below already says it. */}
      {projectsQuery.isError && !(slug === undefined && isProjectScopedSection(section)) && (
        <ErrorState
          compact
          className="mb-4"
          title="Projects could not be loaded"
          description="Project names and pickers on this page may be missing."
          error={projectsQuery.error}
          onRetry={() => {
            void projectsQuery.refetch()
          }}
        />
      )}
      <Suspense fallback={<SectionFallback />}>
        {renderSection({
          section,
          slug,
          isOwner,
          projects,
          projectsStatus: projectsQuery.status,
          onPickProject: pickProject,
          onSlugChanged: followRename,
          projectsError: projectsQuery.error,
          onRetryProjects: () => {
            void projectsQuery.refetch()
          },
        })}
      </Suspense>
    </SettingsLayout>
  )
}

/** Sections that render against one project and so need a slug bound. */
function isProjectScopedSection(section: string): boolean {
  return (
    !ACCOUNT_SECTIONS.has(section) && !section.startsWith('instance/')
  )
}

const ACCOUNT_SECTIONS: ReadonlySet<string> = new Set([
  'members',
  'data-sources',
  'api-keys',
  'profile',
  'security',
])

function renderSection({
  section,
  slug,
  isOwner,
  projects,
  projectsStatus,
  onPickProject,
  onSlugChanged,
  projectsError,
  onRetryProjects,
}: {
  section: string
  slug: string | undefined
  isOwner: boolean
  projects: Project[]
  projectsStatus: 'pending' | 'error' | 'success'
  onPickProject: (slug: string) => void
  onSlugChanged: (slug: string) => void
  projectsError: unknown
  onRetryProjects: () => void
}) {
  if (section === 'members') return <MembersSection />
  if (section === 'data-sources') return <DataSourcesSection />
  if (section === 'api-keys') return <ApiKeysSection />
  if (section === 'profile') return <ProfileSection />
  if (section === 'security') return <SecuritySection />
  if (section.startsWith('instance/')) {
    if (!isOwner) return <OwnerOnly />
    // Audit is the one Instance section that is not a settings form, so it does
    // not go through InstanceSection — that component's whole job is to frame a
    // ServiceSettingsPage section, and this reads a feed instead. It shares the
    // owner gate above rather than adding a second one (tripl-wkwv.17).
    if (section === 'instance/audit') return <WorkspaceAuditSection />
    return <InstanceSection section={section.slice('instance/'.length)} />
  }
  // Everything below is project-scoped. Never guess which project that is.
  if (!slug) {
    return (
      <NoProjectSelected
        projects={projects}
        status={projectsStatus}
        onPick={onPickProject}
        error={projectsError}
        onRetry={onRetryProjects}
      />
    )
  }
  if (section === 'project/plan-rules') return <PlanRulesSection />
  return <ProjectGeneralSection slug={slug} onSlugChanged={onSlugChanged} />
}

/**
 * The two project-scoped routes are the only ones that can render with nothing
 * bound. They used to print "pick a project first" and offer no way to do it,
 * so the user had to leave, choose a project elsewhere and navigate back
 * (tripl-kr4u). The instruction now comes with the control it asks for.
 */
function NoProjectSelected({
  projects,
  status,
  onPick,
  error,
  onRetry,
}: {
  projects: Project[]
  status: 'pending' | 'error' | 'success'
  onPick: (slug: string) => void
  error: unknown
  onRetry: () => void
}) {
  // "There is no project on this workspace yet" is a claim about the server's
  // answer, so it may not be made before the answer arrives. Nothing warms the
  // ['projects'] cache on a /settings/* route — these routes mount outside
  // Layout — so on a cold load every owner of five projects was told they had
  // none for the length of the GET, and offered "Create one in the workspace".
  if (status === 'pending') return <SectionFallback />

  // A retry in place, not "reload the page": a reload throws away whatever
  // else the user had open for a GET the query can simply repeat.
  if (status === 'error') {
    return (
      <ErrorState
        title="No project selected"
        description="The project list could not be loaded, so these settings have nothing to bind to."
        error={error}
        onRetry={onRetry}
      />
    )
  }

  if (projects.length === 0) {
    return (
      <SCard
        title="No project selected"
        description="Project settings change one specific project's tracking plan, and there is no project on this workspace yet."
      >
        <p className="m-0 px-[18px] py-[15px] text-[13px]" style={{ color: 'var(--fg-subtle)' }}>
          <Link to="/workspace" className="underline">
            Create one in the workspace
          </Link>{' '}
          and these settings open with it.
        </p>
      </SCard>
    )
  }

  return (
    <SCard
      title="Pick a project"
      description="Project settings change one specific project's tracking plan, so they need one in context."
    >
      {projects.map((project, index) => (
        <button
          key={project.slug}
          type="button"
          onClick={() => onPick(project.slug)}
          className="flex w-full items-baseline gap-3 px-[18px] py-[13px] text-left transition-colors hover:bg-[var(--surface-hover)]"
          style={{
            borderBottom:
              index === projects.length - 1 ? 'none' : '1px solid var(--border-subtle)',
          }}
        >
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.name}</span>
          <span className="mono shrink-0 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
            {project.slug}
          </span>
        </button>
      ))}
    </SCard>
  )
}

function OwnerOnly() {
  return (
    <div
      className="rounded-xl p-6 text-sm"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--fg-subtle)' }}
    >
      Owner role is required to view or change instance-level settings.
    </div>
  )
}
