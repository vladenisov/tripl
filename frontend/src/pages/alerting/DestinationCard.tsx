import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Pencil, Send } from "lucide-react"
import type { AlertDestination } from "@/types"
import { alertingApi } from "@/api/alerting"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { getErrorMessage } from '@/lib/utils'
import { SILENT_ERROR_META, surfaceError } from "@/lib/errorFeedback"
import { stripValueErrorPrefix } from "@/lib/alertStatus"
import { formatDateTime } from "@/lib/datetime"
import { countOf } from "@/lib/plural"
import { describeCron, formatInProjectZone } from "./deliverySchedule"
import { invalidateAlertingConfig } from "./alertingCache"

interface DestinationCardProps {
  slug: string
  destination: AlertDestination
  // Threaded from the section rather than read here, so one card cannot show a
  // switch its neighbour hides. Everything it guards is an editor-only endpoint
  // (deps.py `require_editor`).
  canWrite: boolean
  onEditDestination: (destination: AlertDestination) => void
}

/**
 * One channel: what it is, whether it is wired up, and how much has gone
 * through it.
 *
 * The rules that route to this destination used to be rendered, edited and
 * deleted inside this card. They now live in the Monitors section
 * (tripl-89ps), which is also where their live firing state is — the state
 * this card never had, and the whole reason a second screen existed to show
 * it. The card keeps the rule COUNT, because "wired up and nothing routes
 * here" is a fact about the destination.
 */
export function DestinationCard({
  slug,
  destination,
  canWrite,
  onEditDestination,
}: DestinationCardProps) {
  const qc = useQueryClient()

  // Goes through the one shared invalidation: a destination write also moves
  // the Inbox and the delivery log, and eight hand-kept copies of
  // `['alertDestinations', slug]` is how none of them did (tripl-oxkt.14).
  //
  // A refusal says why. The switch snaps back to the server's value either
  // way, and on its own that read as a click that did nothing — a 403 after a
  // demotion, or the API refusing to enable a demo's Slack example (ALR-6).
  const updateDestinationMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (data: { enabled?: boolean }) =>
      alertingApi.updateDestination(slug, destination.id, data),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
    onError: error => {
      surfaceError(error, stripValueErrorPrefix)
    },
  })

  // A test send is deliberately NOT invalidating the destinations list: the
  // backend records it in the audit log rather than as an AlertDelivery, so the
  // counts on this card do not move and a refetch would only throw away the
  // answer the operator is reading.
  //
  // `testedVersion` is the channel's configuration fingerprint when the test
  // was sent: a result describes the settings stored THEN. After a change it is
  // hidden rather than left saying "the channel refused… Unauthorized" under a
  // token the operator has just replaced (ALR-40).
  //
  // Not `updated_at`: that moves on every write to the row, including the
  // digest flusher's `last_flushed_at` on each cadence tick and the Enabled
  // switch, so a result vanished at the next refetch with nothing changed. A
  // replaced secret does not move the fingerprint (the `*_set` flag stays
  // true), so opening the editor drops the result too.
  const [testedVersion, setTestedVersion] = useState<string | null>(null)
  const testDestinationMut = useMutation({
    // Its outcome renders on the card, transport failure included.
    meta: SILENT_ERROR_META,
    mutationFn: () => alertingApi.testDestination(slug, destination.id),
  })

  const testIsCurrent = testedVersion === destinationConfigFingerprint(destination)
  const testResult = testIsCurrent ? testDestinationMut.data ?? null : null
  const testFailed = testIsCurrent && testDestinationMut.isError

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          {/* `min-w-0` + `flex-wrap` on the badge row: at 390px the row used to
              clip its own tail, and the tail is the chat id — the only value
              that says WHICH Telegram chat this destination points at
              (tripl-oxkt.18). */}
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{destination.name}</span>
              <Badge variant="outline" className="uppercase text-[10px]">
                {destination.type}
              </Badge>
              <Badge variant={destination.enabled ? 'default' : 'secondary'} className="text-[10px]">
                {destination.enabled ? 'enabled' : 'disabled'}
              </Badge>
              {destination.is_local && (
                <Badge variant="outline" className="text-[10px]">
                  local · nothing is sent
                </Badge>
              )}
              {destination.delivery_schedule_cron && (
                <Badge
                  variant="outline"
                  className="text-[10px]"
                  title={
                    destination.next_digest_at
                      ? `Next digest ${formatInProjectZone(destination.next_digest_at, destination.project_timezone)}`
                      : undefined
                  }
                >
                  {describeCron(destination.delivery_schedule_cron)}
                  {destination.project_timezone ? ` · ${destination.project_timezone}` : ''}
                </Badge>
              )}
              {destination.delivery_schedule_cron && (
                <Badge variant="outline" className="text-[10px]">
                  {destination.held_count
                    ? `${destination.held_count} held`
                    : 'nothing held'}
                </Badge>
              )}
              {destination.type === 'slack' && destination.webhook_set && (
                <Badge variant="outline" className="text-[10px]">webhook set</Badge>
              )}
              {destination.type === 'telegram' && destination.bot_token_set && (
                <Badge variant="outline" className="text-[10px]">bot token set</Badge>
              )}
              {destination.type === 'telegram' && destination.chat_id && (
                <Badge variant="outline" className="max-w-full break-all text-[10px]">
                  chat {destination.chat_id}
                </Badge>
              )}
              {destination.type === 'webhook' && destination.target_url_set && (
                <Badge variant="outline" className="text-[10px]">url set</Badge>
              )}
              {destination.type === 'webhook' && destination.webhook_header_name && (
                <Badge variant="outline" className="text-[10px]">header {destination.webhook_header_name}</Badge>
              )}
            </div>
            {/* Traffic, not just configuration. A destination that has carried
                nothing looks identical to a working one everywhere else on
                this card, and the two are opposite facts (tripl-oxkt.17). The
                rule count stays after the rules themselves moved to Monitors:
                "enabled, wired up, and nothing routes here" is a state worth
                reading off the channel. */}
            <p className="text-xs text-muted-foreground">
              {countOf(destination.rules.length, 'rule', 'rules')}
              {' · '}
              {countOf(destination.delivery_count, 'delivery', 'deliveries')}
              {' · '}
              {countOf(destination.incident_count, 'incident', 'incidents')}
            </p>
          </div>
          {/* The whole control cluster goes for a viewer — a test send puts a
              message in somebody's Slack, and the switch and the pencil are
              both 403s. The card keeps every fact it was showing. */}
          {canWrite && (
          <div className="flex shrink-0 items-center gap-2">
            {/* "bot token set" and a chat id mean a value is STORED. A revoked
                token stores exactly as well as a live one, so the only way to
                answer "did I actually wire this up?" is to push a message
                through the real channel (tripl-oxkt.17). */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setTestedVersion(destinationConfigFingerprint(destination))
                testDestinationMut.mutate()
              }}
              disabled={testDestinationMut.isPending}
              aria-label={`Send a test message through ${destination.name}`}
            >
              <Send aria-hidden="true" className="mr-2 h-4 w-4" />
              {testDestinationMut.isPending ? 'Sending…' : 'Test'}
            </Button>
            {/* `checked` is the server's value, and the control is inert while
                its own write is in flight, so a second click cannot queue a
                write against a state that has not landed yet. */}
            <Switch
              checked={destination.enabled}
              disabled={updateDestinationMut.isPending}
              onCheckedChange={checked => updateDestinationMut.mutate({ enabled: checked })}
              aria-label={`Toggle ${destination.name}`}
            />
            <IconButton variant="ghost" className="h-8 w-8" label={`Edit destination ${destination.name}`} onClick={() => {
              // The editor can replace a secret the fingerprint cannot see.
              setTestedVersion(null)
              onEditDestination(destination)
            }}>
              <Pencil aria-hidden="true" className="h-4 w-4" />
            </IconButton>
          </div>
          )}
        </div>

        {/* A channel refusal arrives as a 200 with `ok: false` — it is the
            answer the button was pressed for, so it renders as a result and
            not as a crash. Only a transport failure gets `role="alert"`. */}
        {(testDestinationMut.isPending || testResult || testFailed) && (
          <div className="flex items-start justify-between gap-2">
          <p
            role={testFailed ? 'alert' : 'status'}
            className={
              testResult?.ok
                ? 'text-xs text-success'
                : testDestinationMut.isPending
                  ? 'text-xs text-muted-foreground'
                  : 'text-xs text-destructive'
            }
          >
            {testDestinationMut.isPending && 'Sending a test message…'}
            {!testDestinationMut.isPending && testResult?.ok && (
              testResult.sent_at
                ? `Test message reached the channel at ${formatDateTime(testResult.sent_at)}.`
                : 'Test message reached the channel.'
            )}
            {!testDestinationMut.isPending && testResult && !testResult.ok && (
              `The channel refused the test message: ${testResult.error ?? 'no reason given'}`
            )}
            {!testDestinationMut.isPending && !testResult && testFailed && (
              `Test send failed: ${getErrorMessage(testDestinationMut.error)}`
            )}
          </p>
          {/* A result stays until the channel's settings change, so the reader
              can put it away once it has been read. */}
          {!testDestinationMut.isPending && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={() => setTestedVersion(null)}
              aria-label={`Dismiss the test result for ${destination.name}`}
            >
              Dismiss
            </Button>
          )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * What a test send was a test OF: the channel type, which secrets are stored,
 * and every non-secret delivery setting. Deliberately leaves out `updated_at`,
 * `enabled`, the schedule and the digest bookkeeping, none of which change
 * whether the channel accepts a message.
 */
function destinationConfigFingerprint(destination: AlertDestination): string {
  return JSON.stringify([
    destination.type,
    destination.webhook_set,
    destination.bot_token_set,
    destination.chat_id,
    destination.target_url_set,
    destination.webhook_header_name,
    destination.email_recipients,
    destination.email_from_address,
    destination.email_subject_template,
    destination.jira_base_url,
    destination.jira_auth_email,
    destination.jira_api_token_set,
    destination.jira_project_key,
    destination.jira_issue_type,
    destination.linear_api_key_set,
    destination.linear_team_id,
    destination.linear_state_id,
    destination.linear_label_ids,
  ])
}
