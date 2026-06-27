import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Command } from 'cmdk'
import {
  Activity,
  Bell,
  Database,
  FileText,
  Folder,
  Layers,
  LayoutDashboard,
  Link2,
  List,
  Loader2,
  LogOut,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Variable,
} from 'lucide-react'
import { aiApi } from '@/api/ai'
import { eventTypesApi } from '@/api/eventTypes'
import { projectsApi } from '@/api/projects'
import { searchApi } from '@/api/search'
import { useAuth } from '@/components/auth-context'
import {
  CommandPaletteContext,
  useCommandPalette,
} from '@/components/command-palette-context'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useAiStatus } from '@/hooks/useAiStatus'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Kbd } from '@/components/primitives/kbd'
import type { AiAskResponse } from '@/api/ai'
import type { SearchEntityType, SearchResult } from '@/types'

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isToggle =
        (event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)
      if (!isToggle) return
      const target = event.target
      if (
        !open &&
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return
      }
      event.preventDefault()
      setOpen(prev => !prev)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const value = useMemo(() => ({ open, setOpen }), [open])

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette />
    </CommandPaletteContext.Provider>
  )
}

const SEARCH_TYPE_META: Record<
  SearchEntityType,
  {
    heading: string
    icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  }
> = {
  event: { heading: 'Events', icon: Tag },
  event_type: { heading: 'Event types', icon: Layers },
  field: { heading: 'Fields', icon: List },
  meta_field: { heading: 'Meta fields', icon: FileText },
  variable: { heading: 'Variables', icon: Variable },
  relation: { heading: 'Relations', icon: Link2 },
  tag: { heading: 'Tags', icon: Tag },
}

function groupSearchResults(results: SearchResult[]) {
  const groups = new Map<SearchEntityType, SearchResult[]>()
  for (const result of results) {
    const items = groups.get(result.entity_type) ?? []
    items.push(result)
    groups.set(result.entity_type, items)
  }
  return Array.from(groups.entries())
}

function CommandPalette() {
  const { open, setOpen } = useCommandPalette()
  const navigate = useNavigate()
  const auth = useAuth()
  const { slug: routeSlug } = useParams()
  const branchId = useActiveBranchId()
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS)
  const [aiQuestion, setAiQuestion] = useState<string | null>(null)
  const [aiResult, setAiResult] = useState<AiAskResponse | null>(null)

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setQuery('')
        setAiQuestion(null)
        setAiResult(null)
      }
      setOpen(next)
    },
    [setOpen],
  )

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
    enabled: open,
  })
  const projects = projectsQuery.data ?? []
  const activeProject = projects.find(p => p.slug === routeSlug) ?? null

  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', activeProject?.slug, branchId],
    queryFn: () => eventTypesApi.list(activeProject!.slug, branchId),
    enabled: open && !!activeProject,
    staleTime: 60_000,
  })
  const eventTypes = eventTypesQuery.data ?? []

  const searchSlug = activeProject?.slug ?? projects[0]?.slug ?? null
  const searchQuery = useQuery({
    queryKey: ['commandPaletteSearch', searchSlug, debouncedQuery],
    queryFn: () =>
      searchApi.search(searchSlug!, { q: debouncedQuery, limit: 12 }),
    enabled: open && !!searchSlug && debouncedQuery.length >= 2,
    staleTime: 30_000,
  })
  const searchResults = useMemo(() => searchQuery.data?.items ?? [], [searchQuery.data])
  const searchGroups = useMemo(() => groupSearchResults(searchResults), [searchResults])

  const aiEnabled = useAiStatus(searchSlug)

  const askMutation = useMutation({
    mutationFn: (question: string) =>
      aiApi.ask(searchSlug!, question, branchId),
    onSuccess: data => setAiResult(data),
  })

  const handleAskAi = useCallback(
    (question: string) => {
      setAiQuestion(question)
      setAiResult(null)
      askMutation.mutate(question)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchSlug, branchId],
  )

  const handleBackFromAi = useCallback(() => {
    setAiQuestion(null)
    setAiResult(null)
    askMutation.reset()
  }, [askMutation])

  const runCommand = useCallback(
    (action: () => void) => {
      setQuery('')
      setOpen(false)
      action()
    },
    [setOpen],
  )

  const goTo = useCallback(
    (path: string) => runCommand(() => navigate(path)),
    [navigate, runCommand],
  )

  const showAskAiAction = aiEnabled && searchSlug && debouncedQuery.length >= 8

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 sm:max-w-[640px] gap-0"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command
          label="Command palette"
          shouldFilter={!aiQuestion}
          className="flex max-h-[480px] w-full min-w-0 flex-col"
        >
          <div
            className="flex items-center gap-2 border-b px-3.5 py-3"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            {aiQuestion ? (
              <>
                <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
                <span className="flex-1 truncate text-[13px]" style={{ color: 'var(--fg)' }}>{aiQuestion}</span>
                <button
                  type="button"
                  onClick={handleBackFromAi}
                  className="shrink-0 text-[11px] px-1.5 py-0.5 rounded"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  ← back
                </button>
                <Kbd>esc</Kbd>
              </>
            ) : (
              <>
                <Search className="h-3.5 w-3.5" style={{ color: 'var(--fg-subtle)' }} />
                <Command.Input
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- command palette search: focus on explicit ⌘K invocation is expected UX
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search projects, event types, events…"
                  className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--fg-subtle)]"
                />
                <Kbd>esc</Kbd>
              </>
            )}
          </div>

          {aiQuestion ? (
            <div className="flex-1 overflow-y-auto py-2 px-3.5">
              {askMutation.isPending && (
                <div className="flex items-center gap-2 py-2 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Asking AI…
                </div>
              )}
              {askMutation.isError && (
                <p className="py-2 text-[12px]" style={{ color: 'var(--destructive)' }}>
                  Error: {askMutation.error instanceof Error ? askMutation.error.message : 'Something went wrong'}
                </p>
              )}
              {aiResult && (
                <div className="space-y-3">
                  <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed" style={{ color: 'var(--fg)' }}>
                    {aiResult.answer}
                  </p>
                  {aiResult.sources.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--fg-faint)' }}>
                        Sources
                      </p>
                      {aiResult.sources.map((source, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => runCommand(() => navigate(source.route_path))}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] hover:bg-[var(--surface-hover)]"
                          style={{ color: 'var(--fg)' }}
                        >
                          <span className="shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--fg-faint)' }}>
                            [{index + 1}]
                          </span>
                          <span className="flex-1 truncate">{source.title}</span>
                          <span className="shrink-0 text-[10px]" style={{ color: 'var(--fg-faint)' }}>
                            {source.entity_type}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
          <Command.List className="flex-1 overflow-y-auto py-1.5">
            <Command.Empty className="px-3.5 py-8 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              No matches.
            </Command.Empty>

            <Group heading="Navigate">
              <Item
                onSelect={() => goTo('/')}
                icon={LayoutDashboard}
                label="Overview"
                hint="/"
              />
              <Item
                onSelect={() => goTo('/settings/data-sources')}
                icon={Database}
                label="Data sources"
                hint="/settings/data-sources"
              />
              <Item
                onSelect={() => goTo('/settings/users')}
                icon={SlidersHorizontal}
                label="Members"
                hint="/settings/users"
              />
              <Item
                onSelect={() => goTo('/settings/account')}
                icon={SlidersHorizontal}
                label="Account"
                hint="/settings/account"
              />
              {auth.user?.role === 'owner' && (
                <Item
                  onSelect={() => goTo('/settings/runtime')}
                  icon={SlidersHorizontal}
                  label="Runtime"
                  hint="/settings/runtime"
                />
              )}
            </Group>

            {activeProject && (
              <Group heading={`Current — ${activeProject.name}`}>
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/events`)}
                  icon={Folder}
                  label="Events"
                  hint={`/p/${activeProject.slug}/events`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings`)}
                  icon={Settings}
                  label="Project settings"
                  hint={`/p/${activeProject.slug}/settings`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings/event-types`)}
                  icon={Layers}
                  label="Event type settings"
                  hint={`/p/${activeProject.slug}/settings/event-types`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings/meta-fields`)}
                  icon={List}
                  label="Meta field settings"
                  hint={`/p/${activeProject.slug}/settings/meta-fields`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings/relations`)}
                  icon={Link2}
                  label="Relation settings"
                  hint={`/p/${activeProject.slug}/settings/relations`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings/variables`)}
                  icon={Variable}
                  label="Variable settings"
                  hint={`/p/${activeProject.slug}/settings/variables`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings/monitoring`)}
                  icon={Activity}
                  label="Monitoring settings"
                  hint={`/p/${activeProject.slug}/settings/monitoring`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings/alerting`)}
                  icon={Bell}
                  label="Alerting settings"
                  hint={`/p/${activeProject.slug}/settings/alerting`}
                />
                <Item
                  onSelect={() => goTo(`/p/${activeProject.slug}/settings/scans`)}
                  icon={Search}
                  label="Scan settings"
                  hint={`/p/${activeProject.slug}/settings/scans`}
                />
              </Group>
            )}

            {projects.length > 0 && (
              <Group heading="Projects">
                {projects.map(project => (
                  <Item
                    key={project.id}
                    onSelect={() => goTo(`/p/${project.slug}/events`)}
                    icon={Folder}
                    label={project.name}
                    hint={project.slug}
                    active={project.slug === routeSlug}
                    keywords={[project.slug, project.name]}
                  />
                ))}
              </Group>
            )}

            {activeProject && eventTypes.length > 0 && (
              <Group heading={`Event types — ${activeProject.name}`}>
                {eventTypes.map(eventType => (
                  <Item
                    key={eventType.id}
                    onSelect={() =>
                      goTo(`/p/${activeProject.slug}/events/${eventType.name}`)
                    }
                    icon={Tag}
                    iconColor={eventType.color}
                    label={eventType.display_name}
                    hint={eventType.name}
                    keywords={[eventType.name, eventType.display_name]}
                  />
                ))}
              </Group>
            )}

            {searchSlug && debouncedQuery.length >= 2 && (
              <>
                {searchQuery.isFetching ? (
                  <Group heading="Searching knowledge…">
                    <div
                      className="px-3.5 py-2 text-[11.5px]"
                      style={{ color: 'var(--fg-subtle)' }}
                    >
                      Searching.
                    </div>
                  </Group>
                ) : searchResults.length === 0 ? (
                  <Group heading={`Knowledge matching "${debouncedQuery}"`}>
                    <div
                      className="px-3.5 py-2 text-[11.5px]"
                      style={{ color: 'var(--fg-subtle)' }}
                    >
                      No knowledge matches.
                    </div>
                  </Group>
                ) : (
                  searchGroups.map(([entityType, results]) => {
                    const meta = SEARCH_TYPE_META[entityType]
                    return (
                      <Group key={entityType} heading={meta.heading}>
                        {results.map(result => {
                          const eventType =
                            result.entity_type === 'event'
                              ? eventTypes.find(item => item.display_name === result.subtitle)
                              : undefined
                          return (
                            <Item
                              key={result.id}
                              onSelect={() => goTo(result.route_path)}
                              icon={meta.icon}
                              iconColor={eventType?.color}
                              label={result.title}
                              hint={result.subtitle || undefined}
                              description={result.description || result.snippet || undefined}
                              confidence={result.confidence}
                              keywords={[
                                debouncedQuery,
                                result.title,
                                result.subtitle,
                                result.description,
                                result.snippet,
                                ...result.highlights,
                              ]}
                            />
                          )
                        })}
                      </Group>
                    )
                  })
                )}
              </>
            )}

            <Group heading="Account">
              <Item
                onSelect={() => runCommand(() => void auth.logout())}
                icon={LogOut}
                label="Sign out"
              />
            </Group>

            {showAskAiAction && (
              <Group heading="AI">
                <Item
                  onSelect={() => handleAskAi(debouncedQuery)}
                  icon={Sparkles}
                  label={`Ask AI: «${debouncedQuery}»`}
                  keywords={[debouncedQuery]}
                />
              </Group>
            )}
          </Command.List>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Command.Group
      heading={heading}
      className="px-1.5 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-[var(--fg-faint)]"
    >
      {children}
    </Command.Group>
  )
}

function confidenceTier(confidence: number): { label: string; color: string } {
  const pct = Math.round(confidence * 100)
  if (confidence >= 0.8) return { label: `${pct}%`, color: 'var(--success)' }
  if (confidence >= 0.5) return { label: `${pct}%`, color: 'var(--warning)' }
  return { label: `${pct}%`, color: 'var(--fg-faint)' }
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const { label, color } = confidenceTier(confidence)
  return (
    <span
      className="mono shrink-0 rounded-sm px-1 text-[9.5px] font-semibold tabular-nums"
      style={{ color, backgroundColor: 'color-mix(in srgb, currentColor 12%, transparent)' }}
      title={`Search confidence: ${label}`}
    >
      {label}
    </span>
  )
}

function Item({
  onSelect,
  icon: Icon,
  iconColor,
  label,
  hint,
  description,
  confidence,
  active,
  keywords,
}: {
  onSelect: () => void
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  iconColor?: string
  label: string
  hint?: string
  description?: string
  confidence?: number
  active?: boolean
  keywords?: string[]
}) {
  const showConfidence = typeof confidence === 'number' && confidence > 0
  return (
    <Command.Item
      value={`${label} ${hint ?? ''} ${(keywords ?? []).join(' ')}`.trim()}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] aria-selected:bg-[var(--surface-hover)]"
      style={{ color: 'var(--fg)' }}
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0 self-start mt-0.5"
        style={{ color: iconColor ?? 'var(--fg-subtle)' }}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate">{label}</span>
        {description && (
          <span className="truncate text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
            {description}
          </span>
        )}
      </span>
      {showConfidence && <ConfidenceBadge confidence={confidence} />}
      {active && (
        <span className="shrink-0 text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--fg-faint)' }}>
          current
        </span>
      )}
      {hint && (
        <span className="mono shrink-0 truncate text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
          {hint}
        </span>
      )}
    </Command.Item>
  )
}
