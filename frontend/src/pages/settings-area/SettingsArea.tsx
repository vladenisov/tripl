import { lazy, Suspense, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { SettingsLayout } from '@/components/settings/SettingsLayout'
import { SETTINGS_STORAGE_KEY } from '@/components/settings/nav'

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
 * URL (when a section route carries one), otherwise the last project visited,
 * otherwise the first project. Mirrors the sidebar's useResolvedSlug so the two
 * stay consistent.
 */
function useSettingsSlug(): string | undefined {
  const { slug: urlSlug } = useParams<{ slug?: string }>()
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: projectsApi.list })
  const projects = projectsQuery.data ?? []
  if (urlSlug) return urlSlug
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST_SLUG_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  if (last && projects.some((p) => p.slug === last)) return last
  return projects[0]?.slug
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
  const navigate = useNavigate()
  const auth = useAuth()
  const isOwner = auth.user?.role === 'owner'
  const slug = useSettingsSlug()

  // Persist the last visited section so re-entering /settings lands where the
  // user left off (the /settings index redirect reads this key).
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, section)
    } catch {
      /* ignore */
    }
  }, [section])

  const onNavigate = (path: string) => navigate(`/settings/${path}`)
  const backHref = slug ? `/p/${slug}/events` : '/'

  return (
    <SettingsLayout activePath={section} onNavigate={onNavigate} backHref={backHref}>
      <Suspense fallback={<SectionFallback />}>
        {renderSection(section, slug, isOwner)}
      </Suspense>
    </SettingsLayout>
  )
}

function renderSection(section: string, slug: string | undefined, isOwner: boolean) {
  if (section === 'project/general') return <ProjectGeneralSection slug={slug} />
  if (section === 'project/plan-rules') return <PlanRulesSection />
  if (section === 'members') return <MembersSection />
  if (section === 'data-sources') return <DataSourcesSection />
  if (section === 'api-keys') return <ApiKeysSection />
  if (section === 'profile') return <ProfileSection />
  if (section === 'security') return <SecuritySection />
  if (section.startsWith('instance/')) {
    if (!isOwner) return <OwnerOnly />
    return <InstanceSection section={section.slice('instance/'.length)} />
  }
  return <ProjectGeneralSection slug={slug} />
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
