import type { Dispatch, SetStateAction } from 'react'
import { Link } from 'react-router-dom'

import { Panel } from '@/components/settings/kit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatDateTime } from '@/lib/datetime'
import { getScopeMonitoringPath } from '@/lib/monitoring'
import { countOf } from '@/lib/plural'
import { getErrorMessage } from '@/lib/utils'
import type { AlertInboxGroup, AlertInboxListResponse } from '@/types'

import { IncidentDeliveries } from './IncidentDeliveries'

// The action set the inbox endpoint accepts. Exported so the page's mutation and
// this component's `onAction` prop cannot drift apart.
export type InboxAction = 'acknowledge' | 'resolve' | 'mute' | 'reopen' | 'false_positive'

interface AlertingInboxProps {
  slug: string
  // Optional, not defaulted to an empty list: the empty state below has to tell
  // "not loaded yet" apart from "loaded and empty".
  inbox: AlertInboxListResponse | undefined
  hasRules: boolean
  // Draft notes and expansion both outlive a section switch, so they are owned
  // by the page, not by this conditionally-rendered component.
  noteDrafts: Record<string, string>
  setNoteDrafts: Dispatch<SetStateAction<Record<string, string>>>
  expandedIncidents: ReadonlySet<string>
  toggleIncident: (correlationGroupId: string) => void
  onAction: (variables: { group: AlertInboxGroup; action: InboxAction }) => void
  isActionPending: boolean
  isActionError: boolean
  actionError: unknown
  onGoToDestinations: () => void
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
  hasRules,
  noteDrafts,
  setNoteDrafts,
  expandedIncidents,
  toggleIncident,
  onAction,
  isActionPending,
  isActionError,
  actionError,
  onGoToDestinations,
  focusDeliveryId,
  focusItemKey,
}: AlertingInboxProps) {
  return (
    <div className="min-w-0 space-y-4">
      {/* Without a rule nothing can correlate, so an empty list here would
          read as "no incidents" when the truth is "nothing can produce
          one". Say which, and where to fix it. */}
      {!hasRules && (
        <Panel title="Inbox" subtitle="0 groups">
          <p className="p-4 text-sm text-muted-foreground">
            No rules yet, so nothing can raise an incident. Add one under{' '}
            <button
              type="button"
              onClick={onGoToDestinations}
              className="underline underline-offset-2"
            >
              Destinations &amp; rules
            </button>
            .
          </p>
        </Panel>
      )}
      {hasRules && (
      <Panel title="Inbox" subtitle={countOf(inbox?.total ?? 0, 'group', 'groups')}>
        <div className="space-y-3 p-4">
          {!inbox || inbox.items.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No correlated alert groups.
            </div>
          ) : (
            <div className="space-y-2">
              {inbox.items.map(group => (
                <div key={group.correlation_group_id} className="rounded-md border p-3 text-xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={group.status === 'false_positive' ? 'destructive' : group.status === 'resolved' ? 'secondary' : 'outline'} className="text-[10px]">
                          {group.status}
                        </Badge>
                        <span className="font-medium">{countOf(group.item_count, 'item', 'items')}</span>
                        <span className="text-muted-foreground">
                          {formatDateTime(group.latest_delivery_at)}
                        </span>
                      </div>
                      <div className="mt-1 truncate text-muted-foreground" title={group.scope_names.join(', ')}>
                        {/* Linked, not just named: the card told you WHAT
                            fired and gave you no way to go look at it, so
                            answering "is this real" meant leaving for the
                            events page and finding it by hand. */}
                        {getScopeMonitoringPath(slug, group) ? (
                          <Link
                            to={getScopeMonitoringPath(slug, group)!}
                            className="underline hover:text-foreground"
                          >
                            {group.scope_names.join(', ')}
                          </Link>
                        ) : (
                          group.scope_names.join(', ')
                        )}
                      </div>
                      <div className="mt-1 truncate text-[10px] text-muted-foreground">
                        {group.rule_names.join(', ')} · {group.scan_names.join(', ')}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                      {group.status === 'resolved' || group.status === 'false_positive' ? (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={isActionPending} onClick={() => onAction({ group, action: 'reopen' })}>
                          Reopen
                        </Button>
                      ) : (
                        <>
                          {group.status === 'open' && (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={isActionPending} onClick={() => onAction({ group, action: 'acknowledge' })}>
                              Ack
                            </Button>
                          )}
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={isActionPending} onClick={() => onAction({ group, action: 'resolve' })}>
                            Resolve
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={isActionPending} onClick={() => onAction({ group, action: 'mute' })}>
                            Mute
                          </Button>
                          {/* One click permanently desensitises the scopes
                              this incident fired on — and nothing else.
                              There is deliberately no confirm step, so the
                              tooltip has to carry what it does and where to
                              undo it. */}
                          <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={isActionPending} title="Closes this incident and permanently makes detection stricter on its scopes only. Undo under Settings › Monitoring › Scope overrides." onClick={() => onAction({ group, action: 'false_positive' })}>
                            False positive
                          </Button>
                          {group.status !== 'open' && (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={isActionPending} onClick={() => onAction({ group, action: 'reopen' })}>
                              Reopen
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {group.muted_until && (
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      muted until {formatDateTime(group.muted_until)}
                    </div>
                  )}
                  {group.note && (
                    <p className="mt-2 rounded border-l-2 border-muted-foreground/30 bg-muted/40 px-2 py-1 text-[11px] leading-5">
                      {group.note}
                    </p>
                  )}
                  <Input
                    aria-label={`Note for alert group ${group.correlation_group_id}`}
                    placeholder={group.note ? 'Replace the note…' : 'Add a note (sent with the next action)'}
                    maxLength={2000}
                    value={noteDrafts[group.correlation_group_id] ?? ''}
                    onChange={event =>
                      setNoteDrafts(current => ({
                        ...current,
                        [group.correlation_group_id]: event.target.value,
                      }))
                    }
                    className="mt-2 h-7 text-[11px]"
                  />
                  {/* "What was sent" belongs to the incident, not to a
                      second list: the message a reader is holding and the
                      buttons that act on it are now the same card. */}
                  <button
                    type="button"
                    aria-expanded={expandedIncidents.has(group.correlation_group_id)}
                    onClick={() => toggleIncident(group.correlation_group_id)}
                    className="mt-2 text-[10.5px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
                  >
                    {expandedIncidents.has(group.correlation_group_id) ? 'Hide' : 'Show'} what was
                    sent ({countOf(group.delivery_count, 'delivery', 'deliveries')})
                  </button>
                  {expandedIncidents.has(group.correlation_group_id) && (
                    <IncidentDeliveries
                      slug={slug}
                      correlationGroupId={group.correlation_group_id}
                      focusDeliveryId={focusDeliveryId}
                      focusItemKey={focusItemKey}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          {isActionError && (
            <p role="alert" className="text-xs text-destructive">{getErrorMessage(actionError)}</p>
          )}
        </div>
      </Panel>
      )}
    </div>
  )
}
