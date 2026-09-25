import { formatNumber } from '@/lib/format'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellOff, ChevronDown, ChevronRight, History, Pencil, Plus, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'

import { alertingApi, type AlertRuleUpdatePayload } from '@/api/alerting'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/empty-state'
import { Panel } from '@/components/settings/kit'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatStrip } from '@/components/primitives/mini-stat'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { useConfirm } from '@/hooks/useConfirm'
import { SILENT_ERROR_META, surfaceError } from '@/lib/errorFeedback'
import { stripValueErrorPrefix } from '@/lib/alertStatus'
import { formatDateTime, formatRelativeTime } from '@/lib/datetime'
import { countOf } from '@/lib/plural'
import { MUTE_PRESETS, muteChoiceName, muteName, muteUntilIso, unmuteName } from '@/lib/mutePresets'
import { VIEWER_READ_ONLY_NOTICE } from '@/lib/permissions'
import {
  MONITOR_STATUS_LABEL as STATUS_LABEL,
  MONITOR_STATUS_TONE as STATUS_TONE,
} from '@/lib/statusLexicon'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { AlertDestination, AlertRule, EventType, MonitorSummaryItem, ScanConfig } from '@/types'

import { invalidateAlertingConfig } from './alertingCache'
import {
  defaultRuleForm,
  directionSummary,
  formatCooldown,
  isDefaultMessageTemplate,
  messageFormatForDestination,
  ruleFormToPayload,
  ruleToForm,
  scopeSummary,
  withMessageFormat,
  type RuleFormState,
} from './constants'
import { describeDeletionImpact } from './deletionImpact'
import { RuleEditorDialog } from './RuleEditorDialog'
import { RuleReplayDialog } from './RuleReplayDialog'
import { monitorsSummaryKey } from '@/lib/queryKeys'

/** A rule carrying the destination it hangs off, as the page flattens it. */
export interface RuleWithDestination extends AlertRule {
  destination_id: string
  destination_name: string
}

// Wide by construction: five facts and five controls per rule. Below the
// minimum it scrolls horizontally rather than crushing the condition into two
// characters — the same treatment the standalone page used at 680px, before it
// absorbed the controls that used to sit on the destination card.
//
// The minimum used to be 980px, which is WIDER than the ~900px this panel gets
// beside the activity rail at 1512px, so the table was clipped at the width the
// app actually renders it: the "Actions" header and two of the five controls
// (Edit, Delete) sat past the right edge, and every text column was sized for a
// table that never fitted. See RULE_TABLE_MIN_WIDTH below.
//
// The action track carries a FLOOR rather than being plain `auto`, because the
// header row and each rule row are separate grids that only look like one
// table: `auto` is measured per grid, so the header sized that column to its
// "Actions" label (~50px) while a row sized it to five controls, and each
// header label landed up to 130px right of the column it names. The floor is
// what a row needs — 188px = a 36px Switch + four 32px icon buttons + four 6px
// `gap-1.5` gutters (52px when a viewer keeps Replay alone) — so both grids
// resolve the same tracks at rest. It stays `minmax`, not fixed, for the one
// state that legitimately needs more: MuteControl reveals its duration presets
// inline, and a fixed track would squash the controls instead of growing.
//
// "Last fired" gets 84px, not the 64px "State" gets, because a column has to fit
// its own header (tripl-fgiv). "LAST FIRED" at the header's 10.5px/600 with
// `tracking-[0.05em]` measures ~65px in Inter and ~69px in the system-ui
// fallback, so at 64px it was the ONE header that wrapped to two lines: the
// whole header row grew a line and every other label floated in it. The cells
// themselves ("22h ago", "–") never needed the width; the label does.
//
// Every column string is written out in full: Tailwind scans source for literal
// class names, so an interpolated `grid-cols-[…]` would never be built.
const RULE_GRID_BASE = 'grid items-center gap-3 px-4'
const RULE_GRID_COLS
  = 'grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,1fr)_64px_84px_minmax(188px,auto)]'
const RULE_GRID_COLS_READ_ONLY
  = 'grid-cols-[minmax(0,2fr)_minmax(0,1.6fr)_minmax(0,1fr)_64px_84px_minmax(52px,auto)]'
// 840px = the 820px the text columns were budgeted at, plus the 20px "Last
// fired" just took, so widening the label's track did not narrow CONDITION.
const RULE_TABLE_MIN_WIDTH = 'min-w-[840px]'

/** The one grid definition the header row and every rule row must share. */
function ruleGridClass(canWrite: boolean): string {
  return `${RULE_GRID_BASE} ${canWrite ? RULE_GRID_COLS : RULE_GRID_COLS_READ_ONLY}`
}

interface MonitorsSectionProps {
  slug: string
  destinations: AlertDestination[]
  rules: RuleWithDestination[]
  eventTypes: EventType[]
  scans: ScanConfig[]
  /**
   * Whether `scans` has answered. Until it has, a scan-bound rule's scan is
   * UNKNOWN rather than missing, and must not read "unknown scan" — the words
   * for a scan that was deleted (ALR-47). Optional: absent means loaded.
   */
  scansLoaded?: boolean
  /** The scan list failed to load: a bound scan's name is unavailable, not pending. */
  scansFailed?: boolean
  canWrite: boolean
  /**
   * Guided setup's step 3 (tripl-oxkt.15): open the rule form prefilled for the
   * destination the reader has just created. It used to be handed to that
   * destination's card; rules no longer live there, so the section takes it.
   */
  autoOpenRuleForDestinationId: string | null
  onAutoOpenRuleConsumed: () => void
  /** Send the reader to the Destinations section — nothing can route without one. */
  onGoToDestinations: () => void
}

/**
 * "Monitors": every alert rule in the project, with the live state that used to
 * be the standalone Monitors page's only reason to exist.
 *
 * The two surfaces described the same object. `get_monitors_summary` selects
 * AlertRule joined to AlertDestination — the same rows the destination cards
 * rendered — so a rule was read on one nav item and edited on another, which is
 * how the two drifted about its mute state (tripl-oxkt.18). Merged here
 * (tripl-89ps): the rule list, its state, and every control that acts on a rule
 * are one screen.
 *
 * State comes from `monitors-summary` and configuration from `destination.rules`,
 * because only the former knows about AlertRuleState. A rule still renders while
 * the summary is in flight — it is not less real for its status being unknown,
 * and blanking the list on every refetch would empty it mid-incident.
 */
export function MonitorsSection({
  slug,
  destinations,
  rules,
  eventTypes,
  scans,
  scansLoaded = true,
  scansFailed = false,
  canWrite,
  autoOpenRuleForDestinationId,
  onAutoOpenRuleConsumed,
  onGoToDestinations,
}: MonitorsSectionProps) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const { notifyStepCompleted } = useDemoScenarioActions()
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<RuleWithDestination | null>(null)
  const [replayingRule, setReplayingRule] = useState<RuleWithDestination | null>(null)
  // The editor's unsaved edits when the replay was opened from its "Replay
  // with these edits" (ALR-12); null replays the saved rule.
  const [replayDraft, setReplayDraft] = useState<AlertRuleUpdatePayload | null>(null)
  const [ruleForm, setRuleForm] = useState<RuleFormState>(defaultRuleForm())
  const [formDestinationId, setFormDestinationId] = useState('')
  // One rule's settings open at a time. The list is for scanning state; the
  // settings behind this are what the destination card used to print in full on
  // every rule, which is why five rules filled a screen before you could see
  // which of them was firing.
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null)

  const summaryQuery = useQuery({
    queryKey: monitorsSummaryKey(slug),
    queryFn: () => alertingApi.getMonitorsSummary(slug),
    enabled: !!slug,
    refetchInterval,
    staleTime: 30_000,
  })
  const summary = summaryQuery.data
  const stateByRule = new Map<string, MonitorSummaryItem>(
    (summary?.monitors ?? []).map(monitor => [monitor.rule_id, monitor]),
  )

  // Same latch the destination card used, and for the same reason: the prop
  // stays set until the page clears it, so without this it would re-open the
  // form on the render right after the reader closed it. Adjusting state during
  // render is React's documented way to follow a prop.
  const [autoOpenConsumed, setAutoOpenConsumed] = useState(false)
  if (autoOpenRuleForDestinationId && !autoOpenConsumed) {
    setAutoOpenConsumed(true)
    setEditingRule(null)
    setRuleForm(defaultRuleForm())
    setFormDestinationId(autoOpenRuleForDestinationId)
    setRuleDialogOpen(true)
  }

  /** Close the rule form and hand the guided-setup instruction back as spent. */
  const dismissRuleDialog = () => {
    setRuleDialogOpen(false)
    setEditingRule(null)
    onAutoOpenRuleConsumed()
  }

  // Every write goes through the one shared invalidation: a rule write also
  // moves the Inbox, the delivery log and this section's own summary
  // (tripl-oxkt.14). Create and update render their error inside the dialog,
  // so they keep the global toast out of it.
  const createRuleMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () => alertingApi.createRule(slug, formDestinationId, ruleFormToPayload(ruleForm)),
    onSuccess: () => {
      invalidateAlertingConfig(qc, slug)
      dismissRuleDialog()
      setRuleForm(defaultRuleForm())
      // A created rule lands the alerting chapter's step — inert outside the
      // demo scenario (the reducer drops every other step).
      notifyStepCompleted('alerting/create-rule')
    },
  })

  const updateRuleMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () => {
      if (!editingRule) throw new Error('Missing rule')
      return alertingApi.updateRule(
        slug,
        editingRule.destination_id,
        editingRule.id,
        ruleFormToPayload(ruleForm),
      )
    },
    onSuccess: () => {
      invalidateAlertingConfig(qc, slug)
      dismissRuleDialog()
      setRuleForm(defaultRuleForm())
    },
  })

  // The row-level writes below have no dialog to report in, and each used to
  // fail with nothing on screen: the switch snapped back, the bin did nothing
  // (ALR-6). They say why in a toast that keeps the global backstop's 401
  // silence, request reference and dedupe (`surfaceError`).
  const reportRowWriteError = (error: unknown) => surfaceError(error, stripValueErrorPrefix)

  const deleteRuleMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (rule: RuleWithDestination) =>
      alertingApi.deleteRule(slug, rule.destination_id, rule.id),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
    onError: reportRowWriteError,
  })

  // `checked` is the server's value, never local state, so a rejected write
  // cannot leave the switch showing a position the server refused. Pending is
  // scoped to the ONE rule being written: a shared flag disables the neighbours
  // for the duration of somebody else's request (tripl-oxkt.18).
  const toggleRuleMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: ({ rule, enabled }: { rule: RuleWithDestination; enabled: boolean }) =>
      alertingApi.updateRule(slug, rule.destination_id, rule.id, { enabled }),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
    onError: reportRowWriteError,
  })

  // Mute moved off the standalone monitor page onto the row. It writes the same
  // `muted_until` the destination card reads, so the two cannot disagree — they
  // are now the same screen.
  const muteMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: ({ rule, mutedUntil }: { rule: RuleWithDestination; mutedUntil: string | null }) =>
      mutedUntil === null
        ? alertingApi.unmuteMonitor(slug, rule.id)
        : alertingApi.muteMonitor(slug, rule.id, mutedUntil),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
    onError: reportRowWriteError,
  })

  // The dialog's error is the previous attempt's; a fresh opening must not
  // show it (ALR-7). Reset on every close and every open, since the
  // guided-setup auto-open above cannot reset during render.
  const resetRuleMutations = () => {
    createRuleMut.reset()
    updateRuleMut.reset()
  }

  const closeRuleDialog = () => {
    dismissRuleDialog()
    resetRuleMutations()
  }

  // Picking another destination keeps the message format only when that
  // channel supports it. `slack_mrkdwn` carried over to a Telegram destination
  // was a 422 on Create, over a format Select that rendered blank (ALR-4).
  const changeFormDestination = (destinationId: string) => {
    setFormDestinationId(destinationId)
    const type = destinations.find(destination => destination.id === destinationId)?.type
    if (!type) return
    setRuleForm(current => {
      const messageFormat = messageFormatForDestination(current.message_format, type)
      return messageFormat === current.message_format
        ? current
        : withMessageFormat(current, messageFormat)
    })
  }

  const openNewRule = () => {
    resetRuleMutations()
    setEditingRule(null)
    setRuleForm(defaultRuleForm())
    // Prefill only when there is no choice to make. With several destinations
    // the picker starts empty and Create stays disabled until one is named,
    // rather than silently routing to whichever sorted first.
    setFormDestinationId(destinations.length === 1 ? (destinations[0]?.id ?? '') : '')
    setRuleDialogOpen(true)
  }

  const openEditRule = (rule: RuleWithDestination) => {
    resetRuleMutations()
    setEditingRule(rule)
    setRuleForm(ruleToForm(rule))
    setFormDestinationId(rule.destination_id)
    setRuleDialogOpen(true)
  }

  const handleDeleteRule = async (rule: RuleWithDestination) => {
    const ok = await confirm({
      title: 'Delete alert rule',
      message: `Delete "${rule.name}"? ${describeDeletionImpact(rule.total_deliveries, rule.incident_count)}`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    // Not while a delete is already in flight: a second confirm used to fire a
    // second DELETE for the same rule.
    if (ok && !deleteRuleMut.isPending) deleteRuleMut.mutate(rule)
  }

  const ruleMutation = editingRule ? updateRuleMut : createRuleMut
  const hasDestinations = destinations.length > 0
  // Through the shared count helper, like the sibling audit panel. This was
  // `${rules.length} routing` — a count with its noun missing, which reads as an
  // unfinished template sitting directly on top of a table of numbers.
  const rulesSubtitle = rules.length > 0
    ? countOf(rules.length, 'routing rule', 'routing rules')
    : undefined

  return (
    <>
      {dialog}

      {/* Once, above everything this section can no longer offer to change —
          rather than a tooltip on each of the switches and bins that are simply
          absent below. */}
      {!canWrite && (
        <p className="rounded-md border border-dashed p-3 text-body-sm text-muted-foreground">
          {VIEWER_READ_ONLY_NOTICE}
        </p>
      )}

      {/* Hidden entirely when nothing is configured, so an all-zero
          FIRING/WARNING/HEALTHY row never sits above the empty state. */}
      {rules.length > 0 && (
        <MiniStatStrip boxed>
          <MiniStat
            label="Firing"
            value={summary ? formatNumber(summary.firing_count) : '—'}
            tone={summary && summary.firing_count > 0 ? 'danger' : 'neutral'}
            pulse={!!summary && summary.firing_count > 0}
            delta={summary && summary.firing_count > 0 ? 'now' : undefined}
          />
          <MiniStat
            label="Warning"
            value={summary ? formatNumber(summary.warning_count) : '—'}
            tone={summary && summary.warning_count > 0 ? 'warning' : 'neutral'}
          />
          <MiniStat
            label="Healthy"
            value={summary ? formatNumber(summary.healthy_count) : '—'}
            tone="success"
          />
          <MiniStat label="Rules" value={formatNumber(rules.length)} />
        </MiniStatStrip>
      )}

      <Panel
        title="Rules"
        subtitle={rulesSubtitle}
        right={
          canWrite && hasDestinations && rules.length > 0 ? (
            // Exactly one coach mark, and only where a demo can act on it: the
            // local sink is the destination whose deliveries never leave the
            // instance. It followed the rule form out of the destination card.
            <ScenarioCoachMark
              step="alerting/create-rule"
              when={destinations.some(destination => destination.is_local)}
            >
              <Button size="sm" variant="outline" onClick={openNewRule}>
                <Plus className="mr-2 h-4 w-4" />
                Add rule
              </Button>
            </ScenarioCoachMark>
          ) : undefined
        }
      >
        {rules.length === 0 ? (
          <div className="py-6">
            <EmptyState
              icon={Bell}
              title="No rules yet"
              description={
                hasDestinations
                  ? 'tripl already watches every event’s rhythm and raises signals on spikes and drops. A rule decides which of those signals matter and where they go.'
                  : 'A rule delivers to a destination, and this project has none yet. Add a channel first, then route signals to it.'
              }
              action={
                !canWrite
                  ? undefined
                  : hasDestinations
                    ? (
                        <Button size="sm" onClick={openNewRule}>
                          <Plus className="mr-2 h-4 w-4" />
                          Add rule
                        </Button>
                      )
                    : (
                        <Button size="sm" variant="outline" onClick={onGoToDestinations}>
                          Add a destination
                        </Button>
                      )
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div role="table" aria-label="Alert rules" className={RULE_TABLE_MIN_WIDTH}>
              <div role="rowgroup">
                <div
                  role="row"
                  className={`${ruleGridClass(canWrite)} border-b py-2 micro-label`}
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
                >
                  <span role="columnheader">Rule</span>
                  <span role="columnheader">Condition</span>
                  <span role="columnheader">Routes to</span>
                  <span role="columnheader">State</span>
                  <span role="columnheader">Last fired</span>
                  <span role="columnheader" className="text-right">Actions</span>
                </div>
              </div>
              <div role="rowgroup">
                {rules.map(rule => (
                  <RuleRow
                    key={rule.id}
                    slug={slug}
                    rule={rule}
                    state={stateByRule.get(rule.id)}
                    scans={scans}
                    scansLoaded={scansLoaded}
                    scansFailed={scansFailed}
                    expanded={expandedRuleId === rule.id}
                    onToggleExpanded={() =>
                      setExpandedRuleId(current => (current === rule.id ? null : rule.id))
                    }
                    canWrite={canWrite}
                    isTogglePending={
                      toggleRuleMut.isPending && toggleRuleMut.variables?.rule.id === rule.id
                    }
                    isMutePending={muteMut.isPending && muteMut.variables?.rule.id === rule.id}
                    isDeletePending={deleteRuleMut.isPending && deleteRuleMut.variables?.id === rule.id}
                    onToggle={enabled => toggleRuleMut.mutate({ rule, enabled })}
                    onMute={mutedUntil => muteMut.mutate({ rule, mutedUntil })}
                    onReplay={() => { setReplayDraft(null); setReplayingRule(rule) }}
                    onEdit={() => openEditRule(rule)}
                    onDelete={() => void handleDeleteRule(rule)}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </Panel>

      {/* Gated on the role as well as on the open flag: `refresh()` can rewrite
          the session mid-visit, and an editor form left open across a demotion
          would still submit its Save. */}
      <RuleEditorDialog
        open={canWrite && ruleDialogOpen}
        onClose={closeRuleDialog}
        slug={slug}
        destinations={destinations}
        destinationId={formDestinationId}
        onDestinationIdChange={changeFormDestination}
        isEditing={!!editingRule}
        ruleForm={ruleForm}
        setRuleForm={setRuleForm}
        eventTypes={eventTypes}
        scans={scans}
        scansLoaded={scansLoaded}
        scansFailed={scansFailed}
        // Both replays from inside the editor (ALR-12): the rule on file, and
        // the rule with this form's edits laid over it server-side, unsaved.
        onReplaySaved={editingRule ? () => { setReplayDraft(null); setReplayingRule(editingRule) } : undefined}
        onReplayDraft={
          editingRule
            ? () => { setReplayDraft(ruleFormToPayload(ruleForm)); setReplayingRule(editingRule) }
            : undefined
        }
        // Rides the monitors-summary response this section already polls, so the
        // editor gains the fact without a second request. Undefined until that
        // request answers, which the dialog reads as "say nothing yet".
        scopeReadiness={summary?.scope_readiness}
        onSubmit={() => ruleMutation.mutate()}
        isPending={ruleMutation.isPending}
        isError={ruleMutation.isError}
        error={ruleMutation.error}
      />

      {replayingRule && (
        <RuleReplayDialog
          open={!!replayingRule}
          onOpenChange={value => { if (!value) { setReplayingRule(null); setReplayDraft(null) } }}
          slug={slug}
          destinationId={replayingRule.destination_id}
          rule={replayingRule}
          scans={scans}
          draft={replayDraft}
        />
      )}
    </>
  )
}

interface RuleRowProps {
  slug: string
  rule: RuleWithDestination
  state: MonitorSummaryItem | undefined
  scans: ScanConfig[]
  scansLoaded: boolean
  scansFailed: boolean
  expanded: boolean
  onToggleExpanded: () => void
  canWrite: boolean
  isTogglePending: boolean
  isMutePending: boolean
  isDeletePending: boolean
  onToggle: (enabled: boolean) => void
  onMute: (mutedUntil: string | null) => void
  onReplay: () => void
  onEdit: () => void
  onDelete: () => void
}

function RuleRow({
  slug,
  rule,
  state,
  scans,
  scansLoaded,
  scansFailed,
  expanded,
  onToggleExpanded,
  canWrite,
  isTogglePending,
  isMutePending,
  isDeletePending,
  onToggle,
  onMute,
  onReplay,
  onEdit,
  onDelete,
}: RuleRowProps) {
  const tone = state ? STATUS_TONE[state.status] : 'neutral'
  const settingsId = `rule-settings-${rule.id}`
  // Built from the rule itself, not from the summary: the condition is
  // configuration, so it renders correctly while the state request is still in
  // flight.
  const directions = [
    rule.notify_on_spike ? 'spike ▲' : null,
    rule.notify_on_drop ? 'drop ▼' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const condition = [
    directions,
    rule.min_percent_delta > 0 ? `≥${rule.min_percent_delta}%` : null,
    // The shared formatter, so one rule reads as one duration on every screen
    // instead of "360m" here and "6h" there (tripl-oxkt.18).
    `cooldown ${formatCooldown(rule.cooldown_minutes)}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
    <div
      role="row"
      className={`${ruleGridClass(canWrite)} min-h-(--row-h) border-b py-2.5 last:border-0`}
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      {/* Nothing in this table ellipsizes any more. Every text cell carried
          `truncate`, and at the width this panel actually gets, a two-row table
          cut five separate strings at once — including CONDITION, which is the
          whole payload of the row: two different rules both ended at "spike ▲ ·
          drop ▼ · ≥100% · co…" and so read as duplicates of each other.
          Wrapping costs a row a line; an ellipsis costs the fact. */}
      <span role="cell" className="flex min-w-0 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {/* Expands the settings this list does not have room for. `Settings`
              names what opens, not the widget — a bare chevron says nothing
              about what is behind it. */}
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            // Only while the row it names is in the document: an
            // aria-controls pointing at nothing is a broken reference (ALR-46).
            aria-controls={expanded ? settingsId : undefined}
            aria-label={`${expanded ? 'Hide' : 'Show'} settings for ${rule.name}`}
            className="shrink-0 rounded-sm p-0.5 transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-faint)' }}
          >
            {expanded
              ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
              : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
          </button>
          <Dot tone={tone} pulse={state?.status === 'firing'} size={7} />
          {/* The detail page is the rule's fired history — the one thing
              neither this row nor its expansion can carry. */}
          <Link
            to={`/p/${slug}/monitors/${rule.id}`}
            className="min-w-0 break-words text-body-sm font-medium no-underline hover:underline"
            style={{ color: 'var(--fg)' }}
          >
            {rule.name}
          </Link>
          {!rule.enabled && <Chip tone="neutral" size="xs">off</Chip>}
          {/* The MIRROR IMAGE of the incident card's muted line in
              AlertingInbox.tsx — read the two together, because the difference
              between them is deliberate and this row looks like an
              inconsistency on its own.

              An INCIDENT has THREE states and its guard must therefore stay
              `group.muted` alone, with the timestamp branched on inside. An
              ALERT RULE has TWO, because `is_rule_muted()`
              (backend `_alerting_monitors.py`) returns FALSE the moment
              `muted_until` is NULL — and NULL is the default on every rule ever
              created:
                - muted     → muted = true,  muted_until = <future>
                - not muted → muted = false, muted_until = NULL or already past
              So `muted && !muted_until` cannot occur here. The second condition
              is NOT a second possibility being handled: it is type narrowing,
              `string | null` down to the `string` formatDateTime needs, written
              out rather than asserted so this row can never print an invalid
              date if the API ever breaks its own contract.

              What stood here was a `: 'muted'` else-branch — dead since it was
              written, and actively misleading since tripl-a50u gave INCIDENTS a
              real open-ended mute. Not because the strings match: the incident
              card spells its open-ended case out as "muted — no end date, until
              you unmute it". Because the SHAPE matches — silenced, with no end
              date to show — and that shape now exists one file away, so a reader
              skimming this row read the bare chip as a rule muted forever. That
              is the opposite of the invariant: a rule's permanent lever is its
              `enabled` switch, never a mute (tripl-b82m).

              Do not restore the else branch. It could only ever fire on a
              contract violation, and "muted, no end" is the one thing it would
              be wrong to say then. The row does go quiet on that impossible
              input — no chip, while the control still offers Unmute — and that
              is the deliberate trade: saying nothing is recoverable, asserting a
              state the product does not have is not. */}
          {rule.muted && rule.muted_until && (
            <Chip tone="warning" size="xs">
              {`muted until ${formatDateTime(rule.muted_until)}`}
            </Chip>
          )}
        </span>
        {/* Delivery health. `Never delivered` is a different fact from `last
            sent 3h ago`, and it followed the rule off the destination card
            rather than being dropped in the move (tripl-oxkt.17). */}
        <span className="break-words pl-6 text-micro" style={{ color: 'var(--fg-faint)' }}>
          {rule.total_deliveries === 0 ? (
            'Never delivered'
          ) : (
            <>
              {countOf(rule.total_deliveries, 'delivery', 'deliveries')}
              {' · '}
              {countOf(rule.incident_count, 'incident', 'incidents')}
              {' · last '}
              {formatRelativeTime(rule.last_delivery_at)}
              {rule.last_delivery_status ? ` · ${rule.last_delivery_status}` : ''}
            </>
          )}
        </span>
      </span>
      <span role="cell" className="tnum break-words text-caption" style={{ color: 'var(--fg-subtle)' }}>
        {condition}
      </span>
      <span role="cell" className="flex min-w-0 flex-col gap-0.5">
        {/* `self-start`, or the flex column stretches the pill to the whole
            column and a one-word chip renders as a wide empty box that reads
            like an input. */}
        {state && (
          <Chip tone="neutral" size="xs" className="self-start">{state.destination_type}</Chip>
        )}
        <span
          className="break-words text-micro"
          style={{ color: 'var(--fg-faint)' }}
          title={`Routes to the "${rule.destination_name}" destination`}
        >
          {rule.destination_name}
        </span>
      </span>
      <span role="cell">
        {state ? (
          <Chip tone={tone} size="xs">{STATUS_LABEL[state.status]}</Chip>
        ) : (
          <span className="text-micro" style={{ color: 'var(--fg-faint)' }}>—</span>
        )}
      </span>
      <span role="cell" className="tnum text-micro" style={{ color: 'var(--fg-faint)' }}>
        {state?.last_anomaly_at ? formatRelativeTime(state.last_anomaly_at) : '—'}
      </span>
      <span role="cell" className="flex shrink-0 items-center justify-end gap-1.5">
        {canWrite && (
          <Switch
            checked={rule.enabled}
            disabled={isTogglePending}
            onCheckedChange={onToggle}
            aria-label={`Toggle ${rule.name}`}
          />
        )}
        {canWrite && (
          <MuteControl
            ruleName={rule.name}
            muted={rule.muted}
            isPending={isMutePending}
            onMute={onMute}
          />
        )}
        {/* Replay stays for everyone: it is the one control here the API does
            not gate, because it saves nothing — a viewer asking "would a
            stricter threshold have cut this noise" is asking a question, not
            making a change (backend alerting.py has no EditorUserDep on
            /simulate). */}
        {/* Exactly one rule coaches the simulate step: the seeded firing rule,
            whose window is guaranteed to hold anomalies. */}
        <ScenarioCoachMark
          step="alerting/simulate"
          when={rule.name === SCENARIO_SEEDED.firingRuleName}
        >
          <IconButton
            variant="ghost"
            className="h-8 w-8"
            onClick={onReplay}
            tooltip="Replay this rule over past data, without saving anything"
            label={`Replay ${rule.name}`}
          >
            <History aria-hidden="true" className="h-4 w-4" />
          </IconButton>
        </ScenarioCoachMark>
        {canWrite && (
          <>
            <IconButton
              variant="ghost"
              className="h-8 w-8"
              label={`Edit rule ${rule.name}`}
              onClick={onEdit}
            >
              <Pencil aria-hidden="true" className="h-4 w-4" />
            </IconButton>
            <IconButton
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              label={`Delete rule ${rule.name}`}
              // The shared cascade sentence, so the control and its confirm
              // count the same way — and "1 delivery", not "1 deliveries"
              // (ALR-45).
              tooltip={`Deletes the rule. ${describeDeletionImpact(rule.total_deliveries, rule.incident_count)}`}
              disabled={isDeletePending}
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
            </IconButton>
          </>
        )}
      </span>
    </div>

    {expanded && (
      <div
        role="row"
        id={settingsId}
        aria-label={`Settings for ${rule.name}`}
        className="border-b px-4 py-3 last:border-0"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
      >
        {/* Every setting labelled, because the whole block used to be a single
            wrapped run of unlabelled spans in which no individual value could be
            found without reading all of them (tripl-oxkt.18).

            One cell spanning all six columns, and a wrapper around the list
            rather than `role="cell"` ON the <dl>: that role replaced the list's
            own, which left every <dt>/<dd> without the parent they require,
            and a one-cell row in a six-column table was announced as sitting
            under "Rule" alone (ALR-46). */}
        <div role="cell" aria-colspan={6}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
          <RuleSetting
            label="Scan"
            value={scanSettingLabel(rule.scan_config_id, scans, scansLoaded, scansFailed)}
          />
          <RuleSetting label="Scopes" value={scopeSummary(rule) || 'none'} />
          <RuleSetting label="Direction" value={directionSummary(rule) || 'none'} />
          <RuleSetting label="Cooldown" value={formatCooldown(rule.cooldown_minutes)} />
          <RuleSetting label="Min %" value={String(rule.min_percent_delta)} />
          <RuleSetting label="Min Δ" value={String(rule.min_absolute_delta)} />
          <RuleSetting label="Min expected" value={String(rule.min_expected_count)} />
          <RuleSetting
            label="Message"
            value={!rule.message_template || isDefaultMessageTemplate(rule.message_template, rule.message_format)
              ? `default (${rule.message_format})`
              : `custom (${rule.message_format})`}
          />
          {!!rule.filters.length && (
            <RuleSetting
              label="Filters"
              value={countOf(rule.filters.length, 'filter', 'filters')}
            />
          )}
        </dl>
        </div>
      </div>
    )}
    </>
  )
}

/**
 * The scan a rule is bound to, as the settings row names it.
 *
 * Three states, not two: while the scan list is still loading the name is not
 * known YET, and printing "unknown scan" then was indistinguishable from the
 * scan having been deleted (ALR-47).
 */
function scanSettingLabel(
  scanConfigId: string | null,
  scans: ScanConfig[],
  scansLoaded: boolean,
  scansFailed: boolean,
): string {
  if (!scanConfigId) return 'all scans'
  const name = scans.find(scan => scan.id === scanConfigId)?.name
  if (name !== undefined) return name
  if (scansLoaded) return 'unknown scan'
  // A failed list will not answer on its own; "…" would read as loading forever.
  return scansFailed ? 'scan unavailable' : '…'
}

/** One rule setting, labelled. */
function RuleSetting({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="micro-label text-muted-foreground">{label}</dt>
      <dd className="break-words text-body-sm text-foreground">{value}</dd>
    </div>
  )
}

/**
 * Mute, with the duration on the label.
 *
 * Presets come from the shared list rather than a local literal — two surfaces
 * muted with different, unlabelled durations before it existed, so re-clicking
 * Mute silently extended a snooze the operator could not read (tripl-oxkt.7).
 *
 * The interaction is the Inbox's, deliberately: a toggle that reveals the
 * durations in place, with the same `Mute <target> for <duration>` labels. Two
 * mute controls on one page that behave differently is the smaller version of
 * the problem this whole merge is fixing.
 *
 * Those labels are now the same because they are the same FUNCTION, not because
 * three files were kept in step by hand: `muteName`, `muteChoiceName` and
 * `unmuteName` come from `@/lib/mutePresets` alongside the durations. Rewording
 * one surface in place is no longer possible without editing the module every
 * mute surface reads (tripl-yapg).
 */
function MuteControl({
  ruleName,
  muted,
  isPending,
  onMute,
}: {
  ruleName: string
  muted: boolean
  isPending: boolean
  onMute: (mutedUntil: string | null) => void
}) {
  const [open, setOpen] = useState(false)

  if (muted) {
    return (
      <IconButton
        variant="ghost"
        className="h-8 w-8"
        disabled={isPending}
        onClick={() => onMute(null)}
        label={unmuteName(ruleName)}
        tooltip="Unmute this rule"
      >
        <Bell aria-hidden="true" className="h-4 w-4" />
      </IconButton>
    )
  }

  return (
    <>
      <IconButton
        variant="ghost"
        className="h-8 w-8"
        disabled={isPending}
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
        // A disclosure toggle, not a mute: it reveals the durations below and
        // writes nothing, which is why it is named by `muteName` and not by
        // `muteChoiceName`. The button that commits carries its duration
        // (tripl-oxkt.7).
        label={muteName(ruleName)}
        tooltip="Mute this rule for a while"
      >
        <BellOff aria-hidden="true" className="h-4 w-4" />
      </IconButton>
      {open && (
        <span className="flex items-center gap-1 text-micro" style={{ color: 'var(--fg-faint)' }}>
          <span>for</span>
          {MUTE_PRESETS.map(preset => (
            <Button
              key={preset.label}
              size="sm"
              variant="outline"
              className="h-6 px-2 text-micro"
              // MUTE_PRESETS' `ms` is `number`, so this call is statically
              // confined to the "for <duration>" branch of `muteChoiceName`.
              // The open-ended phrasing exists inside that builder but is
              // unreachable from here without importing INDEFINITE_MUTE by
              // name — which would be the leak tripl-a50u forbids, since
              // `is_rule_muted()` reads a NULL `muted_until` as NOT MUTED.
              aria-label={muteChoiceName(ruleName, preset)}
              disabled={isPending}
              onClick={() => {
                setOpen(false)
                onMute(muteUntilIso(preset.ms))
              }}
            >
              {preset.label}
            </Button>
          ))}
        </span>
      )}
    </>
  )
}
