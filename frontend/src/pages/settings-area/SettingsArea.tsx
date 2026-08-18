import { lazy, Suspense, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { SCard } from '@/components/settings/kit'
import { SettingsLayout } from '@/components/settings/SettingsLayout'
import { SETTINGS_STORAGE_KEY } from '@/components/settings/nav'
import type { Project } from '@/types'

const ProjectGeneralSection = lazy(() => import('./ProjectGeneralSection'))
const PlanRulesSection = lazy(() => import('./PlanRulesSection'))
const MembersSection = lazy(() => import('./MembersSection'))
const DataSourcesSection = lazy(() => import('./DataSourcesSection'))
const ApiKeysSection = lazy(() => import('./ApiKeysSection'))
const ProfileSection = lazy(() => import('./ProfileSection'))
const SecuritySection = lazy(() => import('./SecuritySection'))
const InstanceSection = lazy(() => import('./InstanceSection'))

const LAST_SLUG_STORAGE_KEY = 'tripl-last-project-slug'

/**
 * Resolve the project the Project-scoped settings target. Prefer the slug in the
 * URL (when a section route carries one), otherwise the last project visited.
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
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: projectsApi.list })
  const projects = projectsQuery.data ?? []
  if (urlSlug) return urlSlug
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
  const isOwner = auth.user?.role === 'owner'
  const [pickedSlug, setPickedSlug] = useState<string | null>(null)
  const slug = useSettingsSlug(pickedSlug)
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: projectsApi.list })
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
      projects={projects}
    >
      <Suspense fallback={<SectionFallback />}>
        {renderSection({
          section,
          slug,
          isOwner,
          projects,
          projectsStatus: projectsQuery.status,
          onPickProject: pickProject,
        })}
      </Suspense>
    </SettingsLayout>
  )
}

function renderSection({
  section,
  slug,
  isOwner,
  projects,
  projectsStatus,
  onPickProject,
}: {
  section: string
  slug: string | undefined
  isOwner: boolean
  projects: Project[]
  projectsStatus: 'pending' | 'error' | 'success'
  onPickProject: (slug: string) => void
}) {
  if (section === 'members') return <MembersSection />
  if (section === 'data-sources') return <DataSourcesSection />
  if (section === 'api-keys') return <ApiKeysSection />
  if (section === 'profile') return <ProfileSection />
  if (section === 'security') return <SecuritySection />
  if (section.startsWith('instance/')) {
    if (!isOwner) return <OwnerOnly />
    return <InstanceSection section={section.slice('instance/'.length)} />
  }
  // Everything below is project-scoped. Never guess which project that is.
  if (!slug) {
    return (
      <NoProjectSelected projects={projects} status={projectsStatus} onPick={onPickProject} />
    )
  }
  if (section === 'project/plan-rules') return <PlanRulesSection />
  return <ProjectGeneralSection slug={slug} />
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
}: {
  projects: Project[]
  status: 'pending' | 'error' | 'success'
  onPick: (slug: string) => void
}) {
  // "There is no project on this workspace yet" is a claim about the server's
  // answer, so it may not be made before the answer arrives. Nothing warms the
  // ['projects'] cache on a /settings/* route — these routes mount outside
  // Layout — so on a cold load every owner of five projects was told they had
  // none for the length of the GET, and offered "Create one in the workspace".
  if (status === 'pending') return <SectionFallback />

  if (status === 'error') {
    return (
      <SCard
        title="No project selected"
        description="The project list could not be loaded, so these settings have nothing to bind to."
      >
        <p className="m-0 px-[18px] py-[15px] text-[13px]" style={{ color: 'var(--fg-subtle)' }}>
          Reload the page to try again.
        </p>
      </SCard>
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
