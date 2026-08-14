import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { Link } from 'react-router-dom'

import { Chip } from '@/components/primitives/chip'
import { Panel } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  ALERT_INBOX_STATUSES,
  alertInboxStatusLabel,
  alertInboxStatusTone,
  incidentDirectionGlyph,
  incidentMagnitudeLabel,
  incidentReasonLabel,
  incidentWorstDeltaLabel,
  isHandledInboxStatus,
  priorDecisionLabel,
} from '@/lib/alertStatus'
import { formatDateTime } from '@/lib/datetime'
import { getScopeMonitoringPath } from '@/lib/monitoring'
import { INBOX_MUTE_CHOICES, muteChoiceUntilIso } from '@/lib/mutePresets'
import { VIEWER_READ_ONLY_NOTICE, useCanWrite } from '@/lib/permissions'
import { countOf } from '@/lib/plural'
import { getErrorMessage } from '@/lib/utils'
import type {
  AlertInboxAction,
  AlertInboxGroup,
  AlertInboxListResponse,
  AlertInboxStatus,
} from '@/types'

import { IncidentDeliveries } from './IncidentDeliveries'

/** The status filter, where `''` is "All" — the state with no `status=` param. */
export type InboxStatusFilter = AlertInboxStatus | ''

/**
 * One action request, as the card raises it.
 *
 * The action union is imported rather than redeclared: this file used to own a
 * five-member `InboxAction` copy that the API type then grew past when `note`
 * was added, and a card cannot ask for something the endpoint rejects.
 *
 * `mutedUntil` is resolved from an {@link INBOX_MUTE_CHOICES} entry at click
 * time, so the instant the confirmation names and the instant that is written
 * are the same one.
 *
 * Its three states are NOT interchangeable, and nothing downstream may branch
 * on truthiness (tripl-a50u):
 *
 *  - `undefined` — this action carries no mute value at all (every action that
 *    is not `mute`).
 *  - a string — mute until that instant.
 *  - `null` — mute with NO end date. The most far-reaching action on the page,
 *    and the one that looks most like "nothing was chosen" at a glance. Every
 *    guard on the path to the request body therefore tests `action === 'mute'`;
 *    a `&& mutedUntil` there silently drops the key from the body or skips the
 *    confirmation for exactly this case.
 */
export interface InboxActionVariables {
  group: AlertInboxGroup
  action: AlertInboxAction
  mutedUntil?: string | null
}

/** How long the list reaches back, server-side (INBOX_LOOKBACK_DAYS). */
const LOOKBACK_LABEL = 'last 30 days'

interface AlertingInboxProps {
  slug: string
  // Optional, not defaulted to an empty list: the empty state below has to tell
  // "not loaded yet" apart from "loaded and empty".
  inbox: AlertInboxListResponse | undefined
  // …and `isError` is the third fact. "No correlated alert groups" asserts the
  // reassuring one, and a failed request is the opposite fact about a queue
  // somebody is deciding whether to look at (tripl-oxkt.10).
  isLoading: boolean
  isError: boolean
  loadError: unknown
  // The `?incident=` group, fetched by id and pinned, when it is NOT in the
  // pages loaded below. An alert's own deep link used to dead-end: it only
  // pre-expanded a card that was never fetched (tripl-oxkt.13).
  pinnedGroup: AlertInboxGroup | null
  hasRules: boolean
  statusFilter: InboxStatusFilter
  onStatusFilterChange: (next: InboxStatusFilter) => void
  onLoadMore: () => void
  hasMore: boolean
  isLoadingMore: boolean
  // Draft notes and expansion both outlive a section switch, so they are owned
  // by the page, not by this conditionally-rendered component.
  noteDrafts: Record<string, string>
  setNoteDrafts: Dispatch<SetStateAction<Record<string, string>>>
  expandedIncidents: ReadonlySet<string>
  toggleIncident: (correlationGroupId: string) => void
  onAction: (variables: InboxActionVariables) => void
  // The ONE row an action is in flight for. A single shared `isActionPending`
  // disabled all ~80 buttons on the page, so triage was strictly serial and the
  // row you touched showed nothing at all (tripl-oxkt.11).
  pendingGroupId: string | null
  // …and the one row whose action failed. The error used to render once, below
  // every card, ~3,000px from the row it was about.
  errorGroupId: string | null
  actionError: unknown
  // Where a reader with no rules is sent. Rules moved off the destination cards
  // into their own section (tripl-89ps), so this points at Monitors — adding a
  // channel is not what unblocks an empty inbox, adding a rule is.
  onGoToMonitors: () => void
  focusDeliveryId?: string
  focusItemKey?: string
}

/**
 * The Inbox section of the alerting page: correlated incident groups and the
 * actions that close them.
 */
export function AlertingInbox({
  slug,
  inbox,
  isLoading,
  isError,
  loadError,
  pinnedGroup,
  hasRules,
  statusFilter,
  onStatusFilterChange,
  onLoadMore,
  hasMore,
  isLoadingMore,
  noteDrafts,
  setNoteDrafts,
  expandedIncidents,
  toggleIncident,
  onAction,
  pendingGroupId,
  errorGroupId,
  actionError,
  onGoToMonitors,
  focusDeliveryId,
  focusItemKey,
}: AlertingInboxProps) {
  const items = inbox?.items ?? []
  const total = inbox?.total ?? 0
  // Every inbox action is editor-only server-side (deps.py `require_editor`),
  // and this page used to render all five buttons on all fifty rows to a viewer
  // whose every click came back 403 (tripl-oxkt.9). Read once for the section;
  // the cards below omit their action cluster entirely rather than showing 250
  // disabled buttons with no explanation attached to any of them.
  const canWrite = useCanWrite()

  // Which OTHER loaded incidents share a scope. Two groups on the same scope
  // are the same event seen through different detectors, and muting one leaves
  // the other paging — the card has to say so, or "I muted it and it came back"
  // is the only available reading (tripl-oxkt.4).
  const siblingsByGroupId = useMemo(() => {
    const byScope = new Map<string, AlertInboxGroup[]>()
    const loaded = inbox?.items ?? []
    const rendered = pinnedGroup ? [pinnedGroup, ...loaded] : loaded
    for (const group of rendered) {
      const bucket = byScope.get(group.scope_ref)
      if (bucket) bucket.push(group)
      else byScope.set(group.scope_ref, [group])
    }
    const out = new Map<string, AlertInboxGroup[]>()
    for (const group of rendered) {
      const others = (byScope.get(group.scope_ref) ?? []).filter(
        other => other.correlation_group_id !== group.correlation_group_id,
      )
      if (others.length > 0) out.set(group.correlation_group_id, others)
    }
    return out
  }, [inbox, pinnedGroup])

  const openCount = items.filter(group => !isHandledInboxStatus(group.status)).length
  const handledCount = items.length - openCount

  const subtitle = isLoading
    ? 'Loading…'
    : isError
      ? 'Could not load'
      : `Showing ${items.length} of ${total} · ${LOOKBACK_LABEL}`

  const renderCard = (group: AlertInboxGroup, isPinned: boolean) => (
    <IncidentCard
      key={group.correlation_group_id}
      slug={slug}
      group={group}
      isPinned={isPinned}
      siblings={siblingsByGroupId.get(group.correlation_group_id) ?? []}
      noteDraft={noteDrafts[group.correlation_group_id] ?? ''}
      setNoteDrafts={setNoteDrafts}
      isExpanded={expandedIncidents.has(group.correlation_group_id)}
      toggleIncident={toggleIncident}
      onAction={onAction}
      canWrite={canWrite}
      isPending={pendingGroupId === group.correlation_group_id}
      errorMessage={
        errorGroupId === group.correlation_group_id ? getErrorMessage(actionError) : null
      }
      focusDeliveryId={focusDeliveryId}
      focusItemKey={focusItemKey}
    />
  )

  return (
    <div className="min-w-0 space-y-4">
      {/* Once, at the head of the section — not on each of the cards, which is
          the same sentence up to fifty times for one fact about the account. */}
      {!canWrite && (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          {VIEWER_READ_ONLY_NOTICE}
        </p>
      )}
      {/* Without a rule nothing can correlate, so an empty list here would
          read as "no incidents" when the truth is "nothing can produce
          one". Say which, and where to fix it. */}
      {!hasRules && (
        <Panel title="Inbox" subtitle="0 groups">
          <p className="p-4 text-sm text-muted-foreground">
            No rules yet, so nothing can raise an incident. Add one under{' '}
            <button
              type="button"
              onClick={onGoToMonitors}
              className="underline underline-offset-2"
            >
              Monitors
            </button>
            .
          </p>
        </Panel>
      )}
      {hasRules && (
      <Panel
        title="Inbox"
        subtitle={subtitle}
        // The Panel's `right` slot was going unused while the list it heads had
        // no control of any kind: 37 of 57 production incidents were reachable
        // by no means at all (tripl-oxkt.1).
        right={
          <StatusFilterChips value={statusFilter} onChange={onStatusFilterChange} />
        }
      >
        <div className="space-y-3 p-4">
          {isLoading ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              Loading incidents…
            </div>
          ) : isError ? (
            <p role="alert" className="rounded-lg border border-dashed p-4 text-sm text-destructive">
              Could not load the inbox: {getErrorMessage(loadError)}
            </p>
          ) : items.length === 0 && !pinnedGroup ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {statusFilter ? (
                <>
                  {/* Naming the filter is the difference between "nothing has
                      ever happened here" and "nothing matches what you asked
                      for" — and the second one is undoable. */}
                  No {alertInboxStatusLabel(statusFilter).toLowerCase()} incidents in the{' '}
                  {LOOKBACK_LABEL}.{' '}
                  <button
                    type="button"
                    onClick={() => onStatusFilterChange('')}
                    className="underline underline-offset-2"
                  >
                    Show all
                  </button>
                </>
              ) : (
                'No correlated alert groups.'
              )}
            </div>
          ) : (
            <>
              {/* Counted over the rows actually loaded, and labelled as such:
                  the server returns a total but no per-status breakdown, and a
                  number that looks project-wide while describing one page is
                  how "52 open" turns into a decision nobody can retrace. */}
              {!statusFilter && items.length > 0 && (
                <p className="text-[10.5px] text-muted-foreground">
                  Of the {countOf(items.length, 'incident', 'incidents')} loaded: {openCount} open ·{' '}
                  {handledCount} handled
                </p>
              )}
              {pinnedGroup && (
                <div className="space-y-1">
                  <p className="text-[10.5px] text-muted-foreground">
                    Linked from an alert. This incident is outside the list below.
                  </p>
                  {renderCard(pinnedGroup, true)}
                </div>
              )}
              <div className="space-y-2">{items.map(group => renderCard(group, false))}</div>
              {hasMore && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={isLoadingMore}
                  onClick={onLoadMore}
                >
                  {isLoadingMore ? 'Loading…' : `Load more (${total - items.length} left)`}
                </Button>
              )}
            </>
          )}
        </div>
      </Panel>
      )}
    </div>
  )
}

function StatusFilterChips({
  value,
  onChange,
}: {
  value: InboxStatusFilter
  onChange: (next: InboxStatusFilter) => void
}) {
  const options: { key: InboxStatusFilter; label: string }[] = [
    { key: '', label: 'All' },
    ...ALERT_INBOX_STATUSES.map(status => ({
      key: status as InboxStatusFilter,
      label: alertInboxStatusLabel(status),
    })),
  ]
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
      {options.map(option => (
        <button
          key={option.key || 'all'}
          type="button"
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
          className="rounded border px-2 py-0.5 text-[11px] transition-colors"
          style={{
            borderColor: value === option.key ? 'var(--accent)' : 'var(--border)',
            color: value === option.key ? 'var(--fg)' : 'var(--fg-subtle)',
            fontWeight: value === option.key ? 600 : 400,
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Short enough to be spoken as part of a button name, long enough to identify. */
function scopeSummary(group: AlertInboxGroup): string {
  const names = group.scope_names.join(', ')
  if (!names) return 'this incident'
  return names.length > 60 ? `${names.slice(0, 59)}…` : names
}

interface IncidentCardProps {
  slug: string
  group: AlertInboxGroup
  isPinned: boolean
  siblings: AlertInboxGroup[]
  noteDraft: string
  setNoteDrafts: Dispatch<SetStateAction<Record<string, string>>>
  isExpanded: boolean
  toggleIncident: (correlationGroupId: string) => void
  onAction: (variables: InboxActionVariables) => void
  // Read from the auth context ONCE by the section above and threaded down, so
  // fifty cards cannot answer the same question fifty different ways.
  canWrite: boolean
  isPending: boolean
  errorMessage: string | null
  focusDeliveryId?: string
  focusItemKey?: string
}

function IncidentCard({
  slug,
  group,
  isPinned,
  siblings,
  noteDraft,
  setNoteDrafts,
  isExpanded,
  toggleIncident,
  onAction,
  canWrite,
  isPending,
  errorMessage,
  focusDeliveryId,
  focusItemKey,
}: IncidentCardProps) {
  const [muteOpen, setMuteOpen] = useState(false)
  // Open when there is already a note to amend or a draft to finish, collapsed
  // when there is not: 20 identical empty inputs were the widest element in
  // every card and added 20 tab stops to a list nobody was writing on
  // (tripl-oxkt.14). Drafts outlive a section switch, so a returning reader
  // must not have to re-find the box holding what they typed.
  const [noteOpen, setNoteOpen] = useState(!!group.note || noteDraft.length > 0)

  const id = group.correlation_group_id
  const target = scopeSummary(group)
  const scopePath = getScopeMonitoringPath(slug, group)
  const reason = incidentReasonLabel(group.direction, group.scope_types)
  const worstDelta = incidentWorstDeltaLabel(group)
  const decision = priorDecisionLabel(group)
  const isMuted = group.status === 'muted'

  const runAction = (action: AlertInboxAction, mutedUntil?: string | null) => {
    setMuteOpen(false)
    onAction({ group, action, mutedUntil })
  }

  return (
    <div
      id={`incident-${id}`}
      className="rounded-md border p-3 text-xs"
      style={isPinned ? { borderColor: 'var(--accent)' } : undefined}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="xs" tone={alertInboxStatusTone(group.status)}>
            {alertInboxStatusLabel(group.status)}
          </Chip>
          {/* Neutral on purpose: this chip is on every row, so it identifies
              rather than alarms. The arrow carries the direction. */}
          <Chip size="xs" tone="neutral">
            {incidentDirectionGlyph(group.direction)} {reason}
          </Chip>
          <span className="font-medium">{countOf(group.item_count, 'item', 'items')}</span>
          <span className="text-muted-foreground">
            {formatDateTime(group.latest_delivery_at)}
          </span>
          {group.false_positive_count > 0 && (
            <span
              className="text-muted-foreground"
              title="How many times this exact group has already been marked a false positive."
            >
              · marked false positive {countOf(group.false_positive_count, 'time', 'times')}
            </span>
          )}
        </div>
        <div className="mt-1 break-words text-muted-foreground">
          {/* Linked, not just named: the card told you WHAT
              fired and gave you no way to go look at it, so
              answering "is this real" meant leaving for the
              events page and finding it by hand.
              `break-words`, not `truncate`: at 390px the identity used to clip
              to nine characters while the buttons kept full width. */}
          {scopePath ? (
            <Link to={scopePath} className="underline hover:text-foreground">
              {group.scope_names.join(', ')}
            </Link>
          ) : (
            group.scope_names.join(', ')
          )}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {incidentMagnitudeLabel(group)}
          {worstDelta && <> · {worstDelta}</>}
        </div>
        <div className="mt-1 text-[10px] text-muted-foreground">
          {/* Each rule is linked by ITS OWN id: `rules` pairs id with name, so
              the card can no longer send "Volume rule" to whichever monitor
              sorted first (tripl-oxkt.4). The monitor page is where the coarse
              mute lives — the one control that fits "silence all of this". */}
          {group.rules.length > 0
            ? group.rules.map((rule, index) => (
                <span key={rule.id}>
                  {index > 0 && ', '}
                  <Link
                    to={`/p/${slug}/monitors/${rule.id}`}
                    className="underline hover:text-foreground"
                  >
                    {rule.name}
                  </Link>
                </span>
              ))
            : group.rule_names.join(', ')}
          {' · '}
          {group.scan_names.join(', ')}
        </div>
        {siblings.length > 0 && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            {siblings.map(sibling => (
              <a
                key={sibling.correlation_group_id}
                href={`#incident-${sibling.correlation_group_id}`}
                className="underline hover:text-foreground"
                title="The same scope is also open as a different kind of signal. Silencing one does not silence the other — they are separate suppression keys."
              >
                also here as {incidentReasonLabel(sibling.direction, sibling.scope_types)}
              </a>
            ))}
          </div>
        )}
        {decision && (
          <div className="mt-1 text-[10px] text-muted-foreground">{decision}</div>
        )}
      </div>
      {/* Guarded on the EFFECTIVE flag, not on the timestamp: a lapsed mute
          used to render an "open" badge and "muted until <a date in the past>"
          on the same card (tripl-oxkt.20).

          There are now THREE cases, and `muted` is the only signal that
          separates two of them, so the outer guard must stay exactly as it is:
            - in force, dated    → muted = true,  muted_until = <future>
            - in force, no end   → muted = true,  muted_until = null (tripl-a50u)
            - lapsed             → muted = false, muted_until = null
          Rewriting this around `muted_until` — the obvious way to make the
          open-ended case render — puts the "Open badge + mute line" card
          straight back. And dropping the inner branch is just as bad the other
          way: an indefinite mute would then say nothing at all, which is the
          silent mute tripl-oxkt.7 exists to remove.

          The open-ended row keeps status `muted` like any other, so the chip
          and the Muted filter need no special case — but its sort key is frozen
          and it never lapses, so it sinks out of the 30-day window for good and
          that filter is the only route back to its Unmute (tripl-oxkt.2). */}
      {group.muted && (
        <div className="mt-2 text-[10px] text-muted-foreground">
          {group.muted_until
            ? `muted until ${formatDateTime(group.muted_until)}`
            : 'muted — no end date, until you unmute it'}
        </div>
      )}
      {group.note && (
        <p className="mt-2 rounded border-l-2 border-muted-foreground/30 bg-muted/40 px-2 py-1 text-[11px] leading-5">
          {group.note}
        </p>
      )}

      {/* Omitted, not disabled, for a viewer: five buttons and a note box per
          card, greyed out and unexplained, is a worse page than one that does
          not offer what the API will refuse. The section says why once, at its
          head, and everything above this line — status, scope, magnitude, prior
          decision, the deliveries — is exactly as readable as it is for an
          editor (tripl-oxkt.9). */}
      {canWrite && (
      <>
      {/* DOM order puts the note FIRST and `order` puts it back underneath:
          the actions used to precede it in the DOM while its placeholder
          promised the text would be "sent with the next action", so a keyboard
          user reached the action first and the note was never sent
          (tripl-oxkt.14). */}
      <div className="mt-2 flex flex-col gap-2">
        <div className="order-2">
          {noteOpen ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Note on ${target}`}
                placeholder={group.note ? 'Replace the note…' : 'Why does this matter?'}
                maxLength={2000}
                value={noteDraft}
                onChange={event =>
                  setNoteDrafts(current => ({ ...current, [id]: event.target.value }))
                }
                className="h-7 min-w-40 flex-1 text-[11px]"
              />
              {/* An explicit save, because a note used to be reachable only as a
                  passenger on an action — so writing down WHY something was a
                  false positive meant first undoing the false positive
                  (tripl-oxkt.14). `note` moves no status and stamps no
                  `acted_at`. */}
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[10px]"
                disabled={isPending || noteDraft.trim().length === 0}
                onClick={() => runAction('note')}
              >
                Save note
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className="text-[10.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {group.note ? 'Edit note' : 'Add note'}
            </button>
          )}
        </div>

        <div className="order-1 flex flex-wrap items-center gap-1">
          {/* FIXED SLOTS. Ack and Reopen used to be conditional, so open rows
              read [Ack][Resolve][Mute][False positive] and muted rows read
              [Resolve][Mute][False positive][Reopen] — row 1's Mute overlapped
              row 3's False positive at the same x, and clicking down the list
              turned a snooze into the destructive action (tripl-oxkt.8). Every
              slot now renders on every row; the inapplicable one is disabled. */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            aria-label={`Acknowledge ${target}`}
            title="Stops re-delivery until the scope goes quiet, then this reopens by itself. Reversible."
            disabled={isPending || group.status !== 'open'}
            onClick={() => runAction('acknowledge')}
          >
            Ack
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            aria-label={`Resolve ${target}`}
            title="Same suppression as Ack, different bucket in the filter. Reopens by itself once the scope goes quiet. Reversible."
            disabled={isPending || group.status === 'resolved'}
            onClick={() => runAction('resolve')}
          >
            Resolve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            aria-expanded={muteOpen}
            aria-label={`${isMuted ? 'Change mute on' : 'Mute'} ${target}`}
            title="Silences this exact scan + rule + scope + signal kind + direction — for a preset duration, or until you unmute it. The only action that survives the scope going quiet."
            disabled={isPending}
            onClick={() => setMuteOpen(current => !current)}
          >
            {isMuted ? 'Change mute' : 'Mute'}
          </Button>
          {/* The undo for a mute is named Unmute. The backend's `reopen` clears
              status AND `muted_until`, which is exactly un-muting — but it was
              labelled "Reopen", a word that does a second, different job on a
              resolved card, and "Unmute" appeared nowhere on the page while
              MonitorDetailPage had a literal Unmute button for the other mute
              system (tripl-oxkt.3). */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            aria-label={`${isMuted ? 'Unmute' : 'Reopen'} ${target}`}
            title={
              isMuted
                ? 'Lifts the mute now — alerts for this resume immediately.'
                : 'Puts this back in the open queue. Alerts resume.'
            }
            disabled={isPending || group.status === 'open'}
            onClick={() => runAction('reopen')}
          >
            {isMuted ? 'Unmute' : 'Reopen'}
          </Button>
          {/* Separated and confirmed: it is the only control on the page that
              changes DETECTION, permanently, and it sat 4px from Mute. */}
          <span className="ml-1 border-l pl-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[10px] text-destructive"
              aria-label={`Mark ${target} as a false positive`}
              title="Closes this incident and permanently makes detection stricter on its scopes only. Asks first, and reports how many scopes it actually changed."
              disabled={isPending || group.status === 'false_positive'}
              onClick={() => runAction('false_positive')}
            >
              False positive
            </Button>
          </span>
        </div>
      </div>

      {muteOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
          {/* Durations on the buttons, not a silent constant in the mutation:
              every mute was 7 days and nothing said so (tripl-oxkt.7).

              INBOX_MUTE_CHOICES, not MUTE_PRESETS: the open-ended choice is
              offered HERE and only here. An incident with a NULL `muted_until`
              is muted forever; a RULE with a NULL `muted_until` is not muted at
              all (`is_rule_muted`), so the same button on the Monitors surfaces
              would do the opposite of its label (tripl-a50u). The list is
              composed in the shared module so this file cannot grow its own
              wording for it. */}
          <span>{isMuted ? 'Change mute to' : 'Mute for'}</span>
          {INBOX_MUTE_CHOICES.map(choice => (
            <Button
              key={choice.label}
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              // "for Until I unmute" is not English, so the open-ended button
              // gets its own phrasing rather than the label spliced into the
              // duration sentence.
              aria-label={
                choice.ms === null
                  ? `Mute ${target} until unmuted`
                  : `Mute ${target} for ${choice.label}`
              }
              disabled={isPending}
              onClick={() => runAction('mute', muteChoiceUntilIso(choice))}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
      </>
      )}

      {/* Inside the failing card, not once below all twenty of them. */}
      {errorMessage && (
        <p role="alert" className="mt-2 text-[10.5px] text-destructive">
          {errorMessage}
        </p>
      )}

      {/* "What was sent" belongs to the incident, not to a
          second list: the message a reader is holding and the
          buttons that act on it are now the same card. */}
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => toggleIncident(id)}
        className="mt-2 text-[10.5px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
      >
        {isExpanded ? 'Hide' : 'Show'} what was sent (
        {countOf(group.delivery_count, 'delivery', 'deliveries')})
      </button>
      {isExpanded && (
        <IncidentDeliveries
          slug={slug}
          correlationGroupId={id}
          focusDeliveryId={focusDeliveryId}
          focusItemKey={focusItemKey}
        />
      )}
    </div>
  )
}
