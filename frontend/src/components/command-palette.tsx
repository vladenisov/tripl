import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
  Gauge,
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
  Table2,
  Tag,
  Variable,
} from 'lucide-react'
import { aiApi } from '@/api/ai'
import { eventTypesApi } from '@/api/eventTypes'
import { projectsApi } from '@/api/projects'
import { searchApi } from '@/api/search'
import { useAuth } from '@/components/auth-context'
import { MAIN_CONTENT_ID } from '@/components/landmarks'
import {
  COMMAND_PALETTE_TRIGGER_ATTR,
  CommandPaletteContext,
  useCommandPalette,
} from '@/components/command-palette-context'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useAiStatus } from '@/hooks/useAiStatus'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Chip } from '@/components/primitives/chip'
import { Kbd } from '@/components/primitives/kbd'
import type { AiAskResponse } from '@/api/ai'
import type { SearchEntityType, SearchResult } from '@/types'

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false)
  const { notifyStepCompleted } = useDemoScenarioActions()

  // Whoever asked for the palette, so Esc can hand focus straight back. Ctrl+K
  // is a window-level shortcut, so on a freshly loaded page nothing is focused
  // and Radix's own restore target is <body> — the next Tab then restarts the
  // sidebar from stop 1 (tripl-jfm3.68).
  const openerRef = useRef<HTMLElement | null>(null)

  const setOpen = useCallback((next: boolean) => {
    if (next) {
      const active = document.activeElement
      openerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null
    }
    setOpenState(next)
  }, [])

  /** Move focus out of the dismissed dialog: opener → top-bar trigger → main content. */
  const restoreFocus = useCallback(() => {
    const candidates = [
      openerRef.current,
      document.querySelector<HTMLElement>(`[${COMMAND_PALETTE_TRIGGER_ATTR}]`),
      document.querySelector<HTMLElement>(`#${MAIN_CONTENT_ID}`),
    ]
    for (const candidate of candidates) {
      if (candidate?.isConnected) {
        candidate.focus()
        return
      }
    }
  }, [])

  // Opening the palette IS using search — the explore chapter's last step.
  // Inert outside a ready demo (the actions context defaults to noops), and
  // the reducer drops the notify unless this is the current step.
  useEffect(() => {
    if (open) notifyStepCompleted('explore/use-search')
  }, [open, notifyStepCompleted])

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
      setOpen(!open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const value = useMemo(() => ({ open, setOpen }), [open, setOpen])

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette onRestoreFocus={restoreFocus} />
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
  metric: { heading: 'Metrics', icon: Gauge },
  fact_table: { heading: 'Fact tables', icon: Table2 },
  scan_config: { heading: 'Scans', icon: Activity },
  alert_rule: { heading: 'Alert rules', icon: Bell },
}

/**
 * Buckets the ranked result list by entity type, preserving the server's order.
 *
 * A `Map` keyed on first appearance is doing load-bearing work here, not just
 * grouping: the groups come out in the order their best result arrived, and each
 * group's rows stay in the order the API sent them. That is the ordering the
 * palette now renders verbatim (tripl-k6gt), so a `sort` added anywhere in this
 * function would undo the fix without touching the component.
 *
 * It does NOT fully preserve rank ACROSS groups: for [event 0.99, variable 0.98,
 * event 0.10] the weak event still lands above the strong variable, because its
 * group opened first. That is a known limitation of showing typed headings at
 * all, and it is a separate decision from the client re-scoring this commit
 * removes.
 */
function groupSearchResults(results: SearchResult[]) {
  const groups = new Map<SearchEntityType, SearchResult[]>()
  for (const result of results) {
    const items = groups.get(result.entity_type) ?? []
    items.push(result)
    groups.set(result.entity_type, items)
  }
  return Array.from(groups.entries())
}

type PaletteIcon = React.ComponentType<{
  className?: string
  style?: React.CSSProperties
}>

declare const paletteValueBrand: unique symbol
/**
 * cmdk's identity for one row — namespaced, and branded so it cannot be typed by
 * hand at a call site.
 *
 * `Item`'s `value` used to be `${label} ${hint} ${keywords}`: a string built to
 * be FUZZY-SCORED, back when cmdk's own filter ran. With that filter off
 * (tripl-k6gt) the string has exactly one job left — cmdk marks a row selected by
 * comparing its `value` against the list's current value — and two rows carrying
 * one string are BOTH announced as `aria-selected`. Two rows do collide once the
 * keyword stuffing is gone: the static Event types row is label=display_name,
 * hint=name, and the server's own event_type document is title=display_name,
 * subtitle=name (backend/src/tripl/services/_search_documents.py:339-343) — the
 * same two strings in the same order. Searching for an event type you can also
 * see in the static list is not an exotic case, it is the common one.
 *
 * The brand is why this is a compile error rather than a comment: every value has
 * to come from `paletteValue`, so a new row cannot be added without picking a
 * namespace, and no namespace can be reached from another one's inputs.
 */
type PaletteValue = string & { readonly [paletteValueBrand]: true }

const paletteValue = {
  nav: (path: string) => `nav:${path}` as PaletteValue,
  project: (projectId: string) => `project:${projectId}` as PaletteValue,
  eventType: (eventTypeId: string) => `event-type:${eventTypeId}` as PaletteValue,
  search: (documentId: string) => `search:${documentId}` as PaletteValue,
  account: (action: string) => `account:${action}` as PaletteValue,
  ai: () => 'ai:ask' as PaletteValue,
}

/** One static row, as data, so its group can decide whether it survives typing. */
interface PaletteRow {
  value: PaletteValue
  label: string
  hint?: string
  icon: PaletteIcon
  iconColor?: string
  active?: boolean
  onSelect: () => void
}

/** A heading and the rows under it, before or after narrowing. */
interface PaletteGroup {
  heading: string
  rows: PaletteRow[]
}

/**
 * Does a static row survive what has been typed so far?
 *
 * cmdk used to answer this, and taking the job off it is the whole of tripl-k6gt:
 * its `shouldFilter` prop covers filtering and SORTING together, so leaving it on
 * to keep the static groups responsive also let it re-append every knowledge
 * result in its own fuzzy-score order (cmdk 1.1.1 `dist/index.mjs` sorts by
 * commandScore, then `appendChild`s each node) — throwing away the relevance
 * ranking the backend spent #113, #114 and a migration computing.
 *
 * Substring rather than a fuzzy score, deliberately. Nothing static is RANKED: a
 * group shows a row or it does not, and the rows inside it stay in the order they
 * are written in. A score here would reintroduce the reordering in miniature.
 *
 * An empty query matches everything, which is what makes a freshly opened palette
 * show the full menu.
 */
function matchesQuery(query: string, haystack: (string | undefined | null)[]): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return haystack.some(term => term?.toLowerCase().includes(needle))
}

/**
 * Narrows each group against the query and drops the ones left with no rows.
 *
 * The narrowing has to happen HERE, in the caller, rather than inside a group
 * component that hides itself: the list-wide "No matches." line has to know
 * whether any static row survived at all, and a component that decides its own
 * visibility can only report that to the DOM. Deriving the survivors up front is
 * what lets the empty state be computed once instead of being guessed twice —
 * "No matches." and "No knowledge matches." used to render on the same
 * keystroke because each was answering a different question.
 *
 * Dropping the whole group and not just its rows is load-bearing on cmdk 1.1.1:
 * with `shouldFilter={false}` a `Command.Group`'s `hidden` computation
 * short-circuits to visible, so a group whose every child returned `null` would
 * keep its heading standing over nothing.
 */
function visibleStaticGroups(query: string, groups: PaletteGroup[]): PaletteGroup[] {
  return groups
    .map(group => ({
      heading: group.heading,
      rows: group.rows.filter(row => matchesQuery(query, [row.label, row.hint])),
    }))
    .filter(group => group.rows.length > 0)
}

/**
 * What the knowledge section of the list is showing right now — exactly one of
 * these, ever.
 *
 * `error` exists because it used to be indistinguishable from `empty`: a failed
 * request left `searchQuery.data?.items ?? []` at zero length and the palette
 * announced "No knowledge matches.", i.e. told the user their knowledge base
 * held nothing when in fact the request never completed.
 *
 * `off` is the only state in which the list-wide empty line may render, which is
 * what makes the two empty states mutually exclusive by construction.
 */
type KnowledgeState = 'off' | 'searching' | 'error' | 'empty' | 'results'

function CommandPalette({ onRestoreFocus }: { onRestoreFocus: () => void }) {
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

  // A route row's path is its hint, its identity and its action all at once, so
  // it is written once. Every nav row was previously three lines of JSX repeating
  // the same string three times; the array form is what lets `StaticGroup` filter
  // them at all, since a row has to be data before a group can count how many of
  // them are left (tripl-k6gt).
  const navRow = (path: string, label: string, icon: PaletteIcon): PaletteRow => ({
    value: paletteValue.nav(path),
    label,
    hint: path,
    icon,
    onSelect: () => goTo(path),
  })

  const navigateRows: PaletteRow[] = [
    navRow('/', 'Overview', LayoutDashboard),
    navRow('/settings/data-sources', 'Data sources', Database),
    navRow('/settings/users', 'Members', SlidersHorizontal),
    navRow('/settings/account', 'Account', SlidersHorizontal),
    ...(auth.user?.role === 'owner'
      ? [navRow('/settings/runtime', 'Runtime', SlidersHorizontal)]
      : []),
  ]

  const currentProjectRows: PaletteRow[] = activeProject
    ? [
        navRow(`/p/${activeProject.slug}/events`, 'Events', Folder),
        navRow(`/p/${activeProject.slug}/settings`, 'Project settings', Settings),
        navRow(`/p/${activeProject.slug}/settings/event-types`, 'Event type settings', Layers),
        navRow(`/p/${activeProject.slug}/settings/meta-fields`, 'Meta field settings', List),
        navRow(`/p/${activeProject.slug}/settings/relations`, 'Relation settings', Link2),
        navRow(`/p/${activeProject.slug}/settings/variables`, 'Variable settings', Variable),
        navRow(`/p/${activeProject.slug}/settings/monitoring`, 'Monitoring settings', Activity),
        navRow(`/p/${activeProject.slug}/settings/alerting`, 'Alerting settings', Bell),
        // Not "Scan settings": scans are an operational surface with their own
        // top-level route, not a settings tab.
        navRow(`/p/${activeProject.slug}/scans`, 'Scans', Search),
      ]
    : []

  // The slug is the hint, so it is already in the haystack `StaticGroup` matches
  // against — which is what keeps a project findable by slug now that cmdk is no
  // longer scoring a stuffed keyword string.
  const projectRows: PaletteRow[] = projects.map(project => ({
    value: paletteValue.project(project.id),
    label: project.name,
    hint: project.slug,
    icon: Folder,
    active: project.slug === routeSlug,
    onSelect: () => goTo(`/p/${project.slug}/events`),
  }))

  // Same arrangement, and the same reason: the raw `name` an engineer would type
  // is the hint, the human `display_name` is the label, and both are matched.
  const eventTypeRows: PaletteRow[] = activeProject
    ? eventTypes.map(eventType => ({
        value: paletteValue.eventType(eventType.id),
        label: eventType.display_name,
        hint: eventType.name,
        icon: Tag,
        iconColor: eventType.color,
        onSelect: () => goTo(`/p/${activeProject.slug}/events/${eventType.name}`),
      }))
    : []

  const accountRows: PaletteRow[] = [
    {
      value: paletteValue.account('sign-out'),
      label: 'Sign out',
      icon: LogOut,
      onSelect: () => runCommand(() => void auth.logout()),
    },
  ]

  // Two calls rather than one because the Account group is rendered BELOW the
  // knowledge results while the rest are above them, and the reading order is
  // part of the design.
  const menuGroups = visibleStaticGroups(query, [
    { heading: 'Navigate', rows: navigateRows },
    ...(activeProject
      ? [{ heading: `Current — ${activeProject.name}`, rows: currentProjectRows }]
      : []),
    { heading: 'Projects', rows: projectRows },
    ...(activeProject
      ? [{ heading: `Event types — ${activeProject.name}`, rows: eventTypeRows }]
      : []),
  ])
  const accountGroups = visibleStaticGroups(query, [
    { heading: 'Account', rows: accountRows },
  ])

  // Derived from the LIVE query, not the debounced one. A search is already
  // coming during the 200ms debounce window, and calling that window "no search
  // running" is what made the empty line flash on every query whose first
  // characters miss the static rows — those rows narrow against the live query,
  // so they are gone before the request is even sent.
  const knowledgeState: KnowledgeState = !searchSlug || query.trim().length < 2
    ? 'off'
    : query.trim() !== debouncedQuery || searchQuery.isFetching
      ? 'searching'
      : searchQuery.isError
        ? 'error'
        : searchResults.length > 0
          ? 'results'
          : 'empty'

  // The list's single "we found you nothing" line, decided in one place. It is
  // reachable only while the knowledge section is absent, so it can never stack
  // with that section's own empty line — the defect where a query matching no
  // static row and returning no results rendered "No matches." AND
  // "No knowledge matches." together.
  const showNoMatches =
    knowledgeState === 'off' &&
    menuGroups.length === 0 &&
    accountGroups.length === 0 &&
    !showAskAiAction

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="overflow-hidden p-0 sm:max-w-[640px] gap-0"
        // Take over Radix's focus restore: it aims at whatever was focused when
        // the dialog mounted, which for a global Ctrl+K is usually <body>.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command
          label="Command palette"
          // Off, always. cmdk's filter is also a SORT — it re-appends every
          // rendered item in commandScore order on each keystroke — so leaving it
          // on discarded the backend's relevance ranking before anyone saw it
          // (tripl-k6gt). The static groups do their own filtering below; the
          // knowledge results are ranked and filtered server-side and must reach
          // the DOM untouched.
          shouldFilter={false}
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
            {/* A plain div, deliberately NOT `Command.Empty`. cmdk's version
                renders on `filtered.count === 0`, and with `shouldFilter={false}`
                that count is just the number of REGISTERED items — which counts
                neither the "Searching knowledge…" group nor the failed-search
                line, since both hold a plain div and register nothing. So it
                reported "empty" while the user was looking at a spinner, and
                stacked underneath the knowledge section's own empty line.
                `showNoMatches` answers the question once, above. */}
            {showNoMatches && (
              <div className="px-3.5 py-8 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                No matches.
              </div>
            )}

            <StaticGroups groups={menuGroups} />

            {knowledgeState !== 'off' && (
              <>
                {/* All three status groups hold a plain div and register no cmdk
                    item. Before this commit that made them dead on arrival: with
                    the client filter on, a `Command.Group` with no MATCHING item
                    was hidden, and a query is the only way to reach any of these
                    branches — so nobody had seen a spinner or a "no knowledge
                    matches" line in the palette. With the filter off cmdk never
                    hides a group, and they render for the first time. */}
                {knowledgeState === 'searching' ? (
                  <Group heading="Searching knowledge…">
                    <div
                      className="px-3.5 py-2 text-[11.5px]"
                      style={{ color: 'var(--fg-subtle)' }}
                    >
                      Searching.
                    </div>
                  </Group>
                ) : knowledgeState === 'error' ? (
                  // Says the request failed, and never "nothing found". An empty
                  // `items` array is what a failed request and an empty knowledge
                  // base used to have in common (`data?.items ?? []`), so the
                  // palette reported an outage as a fact about the user's data.
                  <Group heading="Knowledge search">
                    <div
                      className="px-3.5 py-2 text-[11.5px]"
                      style={{ color: 'var(--destructive)' }}
                    >
                      Knowledge search failed. Results may be missing — try again.
                    </div>
                  </Group>
                ) : knowledgeState === 'empty' ? (
                  <Group heading={`Knowledge matching "${debouncedQuery}"`}>
                    <div
                      className="px-3.5 py-2 text-[11.5px]"
                      style={{ color: 'var(--fg-subtle)' }}
                    >
                      No knowledge matches.
                    </div>
                  </Group>
                ) : (
                  // Rendered exactly as received: no `.filter`, no `.sort` and no
                  // `matchesQuery` within each entity-type bucket — these rows
                  // were already matched and ranked by the search service, and
                  // second-guessing that here is the defect this commit removes
                  // (tripl-k6gt). What bucketing costs ACROSS buckets is spelled
                  // out on `groupSearchResults`.
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
                              value={paletteValue.search(result.id)}
                              onSelect={() => goTo(result.route_path)}
                              icon={meta.icon}
                              iconColor={eventType?.color}
                              label={result.title}
                              hint={result.subtitle || undefined}
                              description={result.description || result.snippet || undefined}
                              confidence={result.confidence}
                              semantic={result.semantic_used}
                            />
                          )
                        })}
                      </Group>
                    )
                  })
                )}
              </>
            )}

            <StaticGroups groups={accountGroups} />

            {showAskAiAction && (
              // Deliberately NOT run through `matchesQuery`. This row is the
              // query, so matching it against the query is either a tautology or,
              // during the debounce window, false — the label still quotes the
              // previous `debouncedQuery` while `query` has moved on, so the offer
              // would blink out mid-word on every keystroke. `showAskAiAction` is
              // already its visibility rule.
              <Group heading="AI">
                <Item
                  value={paletteValue.ai()}
                  onSelect={() => handleAskAi(debouncedQuery)}
                  icon={Sparkles}
                  label={`Ask AI: «${debouncedQuery}»`}
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

/**
 * Renders already-narrowed groups. Every group it is handed has at least one
 * row, because `visibleStaticGroups` dropped the empty ones — see there for why
 * an empty group must not reach the DOM at all under `shouldFilter={false}`.
 */
function StaticGroups({ groups }: { groups: PaletteGroup[] }) {
  return (
    <>
      {groups.map(group => (
        <Group key={group.heading} heading={group.heading}>
          {group.rows.map(row => (
            <Item key={row.value} {...row} />
          ))}
        </Group>
      ))}
    </>
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
  value,
  onSelect,
  icon: Icon,
  iconColor,
  label,
  hint,
  description,
  confidence,
  semantic,
  active,
}: PaletteRow & {
  description?: string
  confidence?: number
  semantic?: boolean
}) {
  const showConfidence = typeof confidence === 'number' && confidence > 0
  return (
    <Command.Item
      value={value}
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
      {semantic && (
        <Chip tone="neutral" size="xs" title="Matched by meaning (semantic search)">
          semantic
        </Chip>
      )}
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
