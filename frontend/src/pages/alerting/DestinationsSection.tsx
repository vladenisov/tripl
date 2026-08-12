import { useMemo } from 'react'
import { Trash2, Webhook } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { VIEWER_READ_ONLY_NOTICE, useCanWrite } from '@/lib/permissions'
import type { AlertDestination, EventType, ScanConfig } from '@/types'

import { CHANNEL_META } from './channelMeta'
import { DestinationCard } from './DestinationCard'
import { describeDeletionImpact } from './deletionImpact'
import { RoutingRulesPanel } from './RoutingRulesPanel'
import type { DestinationChannel } from './constants'

interface DestinationsSectionProps {
  slug: string
  destinations: AlertDestination[]
  eventTypes: EventType[]
  scans: ScanConfig[]
  isDemo: boolean
  onCreateDestination: (channel: DestinationChannel) => void
  onEditDestination: (destination: AlertDestination) => void
  onDeleteDestination: (destination: AlertDestination) => void
}

/**
 * The "Destinations & rules" section: the routing matrix plus the per-channel
 * destination cards and the add-a-channel affordances.
 *
 * The create/edit dialog deliberately stays with the page: guided setup calls
 * the same `onCreateDestination` while this section is not mounted at all.
 */
export function DestinationsSection({
  slug,
  destinations,
  eventTypes,
  scans,
  isDemo,
  onCreateDestination,
  onEditDestination,
  onDeleteDestination,
}: DestinationsSectionProps) {
  // A demo's local sink has no entry in CHANNEL_META (it is not a channel anyone
  // can add), so it fell straight through the per-channel grouping below and its
  // card was never rendered: a demo's Destinations panel showed only the
  // permanently-disabled Slack example, while the sink that actually receives the
  // seeded deliveries stayed invisible — even though its rules did appear under
  // Routing rules. It gets its own group (tripl-2su6.20).
  const localSinks = useMemo(
    () => destinations.filter((destination) => destination.type === 'demo_sink'),
    [destinations],
  )
  const groupedDestinations = useMemo(() => ({
    slack: destinations.filter(destination => destination.type === 'slack'),
    telegram: destinations.filter(destination => destination.type === 'telegram'),
    webhook: destinations.filter(destination => destination.type === 'webhook'),
    email: destinations.filter(destination => destination.type === 'email'),
    jira: destinations.filter(destination => destination.type === 'jira'),
    linear: destinations.filter(destination => destination.type === 'linear'),
  }), [destinations])

  const hasDestinations = destinations.length > 0
  // Creating, editing and deleting a destination or a rule are all editor-only
  // (deps.py `require_editor`), so a viewer gets the configuration as a
  // read-only report: every value stays on screen, nothing offers to change it
  // (tripl-oxkt.9).
  const canWrite = useCanWrite()
  // One source of truth for the channel buttons so the zero-state CTA and the
  // populated-state "add another" row stay in sync.
  const channelButtons = CHANNEL_META.map(({ channel, label, Icon }) => (
    <Button key={channel} variant="outline" size="sm" onClick={() => onCreateDestination(channel)}>
      <Icon className="mr-2 h-4 w-4" />
      {label}
    </Button>
  ))
  const demoChannelNotice = (
    <p className="text-xs text-muted-foreground">
      This demo is local-only: alerts render to a built-in sink and are never sent to Slack,
      Telegram, a webhook, email, Jira or Linear. Create a real project to connect a channel.
    </p>
  )

  return (
    <>
    {/* Once, above everything this section can no longer offer to change —
        rather than a tooltip on each of the switches, pencils and bins that
        are simply absent below. */}
    {!canWrite && (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {VIEWER_READ_ONLY_NOTICE}
      </p>
    )}
    {/* The read-only rule → destination summary is the verification half of
        configuring a route ("did I actually wire this up?"), so it belongs
        with the destinations rather than on its own. */}
    <RoutingRulesPanel slug={slug} />

    <div className="grid gap-6">
      <div className="min-w-0 space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Destinations</h3>
          <p className="text-xs text-muted-foreground">
            Signals route to destinations via rules.
          </p>
        </div>

        {!hasDestinations && (
          // Inlined empty state with trimmed vertical padding (py-8 vs the shared
          // EmptyState's py-16) so the heading, message, and channel buttons read as
          // one connected block instead of floating below an awkward void.
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Webhook className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-sm font-semibold text-foreground">No alert destinations</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Create a Slack webhook, Telegram bot, or generic webhook destination, then attach rules to it.
            </p>
            {isDemo ? (
              <div className="mt-4 max-w-sm">{demoChannelNotice}</div>
            ) : !canWrite ? null : (
              <div className="mt-4 flex flex-col items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Add a channel</span>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {channelButtons}
                </div>
              </div>
            )}
          </div>
        )}

        {localSinks.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">Local sink</h4>
              <Badge variant="outline" className="text-[10px]">
                {localSinks.length}
              </Badge>
            </div>
            {/* No delete affordance: the sink is part of the demo scenario and
                owns its seeded rules and deliveries. Reset re-creates it. */}
            {localSinks.map((destination) => (
              <DestinationCard
                key={destination.id}
                slug={slug}
                destination={destination}
                eventTypes={eventTypes}
                scans={scans}
                canWrite={canWrite}
                onEditDestination={onEditDestination}
              />
            ))}
          </div>
        )}

        {CHANNEL_META
          .filter(({ channel }) => groupedDestinations[channel].length > 0)
          .map(({ channel, label }) => (
            <div key={channel} className="space-y-3">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium">{label}</h4>
                <Badge variant="outline" className="text-[10px]">
                  {groupedDestinations[channel].length}
                </Badge>
              </div>
              {groupedDestinations[channel].map(destination => (
                <div key={destination.id}>
                  <DestinationCard
                    slug={slug}
                    destination={destination}
                    eventTypes={eventTypes}
                    scans={scans}
                    canWrite={canWrite}
                    onEditDestination={onEditDestination}
                  />
                  {/* The confirm itself lives on the page that owns the delete
                      mutation; the cascade it triggers is stated here too, on
                      the control, because a `title` reaches a reader who is
                      still deciding whether to press it (tripl-oxkt.13). */}
                  {canWrite && (
                    <div className="mt-2 flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground hover:text-destructive"
                        title={`Deletes "${destination.name}", its rules, and their history. ${describeDeletionImpact(destination.delivery_count, destination.incident_count)}`}
                        onClick={() => onDeleteDestination(destination)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete destination
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}

        {/* Once at least one destination exists, empty channels collapse into this
            compact row instead of rendering bare headers — every type stays one click
            away without taking vertical space for nothing. The zero-state CTA lives in
            the EmptyState above, so this "add another" row is for the populated view. */}
        {/* Gone entirely for a viewer: "Add another channel" over a row of
            buttons that answer 403 is an invitation, not information. */}
        {hasDestinations && (canWrite || isDemo) && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3">
            {isDemo ? (
              demoChannelNotice
            ) : (
              <>
                <span className="text-xs font-medium text-muted-foreground">Add another channel</span>
                {channelButtons}
              </>
            )}
          </div>
        )}
      </div>
    </div>
    </>
  )
}
