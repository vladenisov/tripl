import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { History, Pencil, Plus, Send, Trash2 } from "lucide-react"
import { Link } from "react-router-dom"
import type {
  AlertDeliveryStatus,
  AlertDestination,
  AlertRule,
  EventType,
  ScanConfig,
} from "@/types"
import { alertingApi } from "@/api/alerting"
import { ScenarioCoachMark } from "@/demo/ScenarioCoachMark"
import { useDemoScenarioActions } from "@/demo/demoScenarioContext"
import { SCENARIO_SEEDED } from "@/demo/scenarioModel"
import { useConfirm } from "@/hooks/useConfirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { FilterEditor } from "./FilterEditor"
import { RuleReplayDialog } from "./RuleReplayDialog"
import { TemplateEditor } from "./TemplateEditor"
import {
  ALL_SCANS_OPTION,
  ITEM_TEMPLATE_VARIABLE_OPTIONS,
  TEMPLATE_VARIABLE_OPTIONS,
  defaultRuleForm,
  directionSummary,
  formatCooldown,
  getDefaultItemsTemplate,
  getDefaultMessageTemplate,
  isDefaultItemsTemplate,
  isDefaultMessageTemplate,
  normalizeRuleTemplate,
  ruleFormToPayload,
  ruleToForm,
  scopeSummary,
  type RuleFormState,
} from "./constants"
import { getErrorMessage } from '@/lib/utils'
import { formatDateTime, formatRelativeTime } from "@/lib/datetime"
import { countOf } from "@/lib/plural"
import { invalidateAlertingConfig } from "./alertingCache"
import { describeDeletionImpact } from "./deletionImpact"

const DELIVERY_STATUS_VARIANT: Record<AlertDeliveryStatus, 'success' | 'warning' | 'destructive'> = {
  sent: 'success',
  pending: 'warning',
  failed: 'destructive',
}

/**
 * One rule setting, labelled.
 *
 * The whole block used to be a single wrapped run of unlabelled spans — "Scan:
 * all scans Scopes: total, groups, events, schema, distribution, regressions,
 * value drift / Direction: up / down Cooldown: 6h Min %: 100 …" — one line of
 * prose in which no individual setting could be found without reading all of
 * them (tripl-oxkt.18).
 */
function RuleSetting({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="break-words text-xs text-foreground">{value}</dd>
    </div>
  )
}

interface DestinationCardProps {
  slug: string
  destination: AlertDestination
  eventTypes: EventType[]
  scans: ScanConfig[]
  // Threaded from the section rather than read here, so one card cannot show a
  // switch its neighbour hides. Everything it guards is an editor-only endpoint
  // (deps.py `require_editor`) — with one deliberate exception, Replay, which
  // the API leaves open because it saves nothing (tripl-oxkt.9).
  canWrite: boolean
  onEditDestination: (destination: AlertDestination) => void
  // Guided setup's step 3 (tripl-oxkt.15): `true` on the card for the
  // destination the reader has just created, which opens its own rule form once
  // and then reports back so the instruction can be cleared.
  autoOpenRule?: boolean
  onAutoOpenRuleConsumed?: () => void
}

export function DestinationCard({
  slug,
  destination,
  eventTypes,
  scans,
  canWrite,
  onEditDestination,
  autoOpenRule = false,
  onAutoOpenRuleConsumed,
}: DestinationCardProps) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const { notifyStepCompleted } = useDemoScenarioActions()
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null)
  const [replayingRule, setReplayingRule] = useState<AlertRule | null>(null)
  const [ruleForm, setRuleForm] = useState<RuleFormState>(defaultRuleForm())

  // Guided setup's step 3, executed by the card that owns the newly created
  // destination (tripl-oxkt.15). Adjusting state during render is React's
  // documented way to follow a prop — the same shape the page uses for `?scan=`
  // — and it is the only one available here: an effect that opens the dialog is
  // a cascading render (and `react-hooks/set-state-in-effect` rejects it).
  //
  // The latch is what makes it happen ONCE. Without it the prop, which stays
  // set until the page clears it, would re-open the form on the render right
  // after the reader closed it.
  const [autoOpenConsumed, setAutoOpenConsumed] = useState(false)
  if (autoOpenRule && !autoOpenConsumed) {
    setAutoOpenConsumed(true)
    setEditingRule(null)
    setRuleForm(defaultRuleForm())
    setRuleDialogOpen(true)
  }

  // Every write below goes through the one shared invalidation: a rule or
  // destination write also moves the Inbox and the delivery log, and eight
  // hand-kept copies of `['alertDestinations', slug]` is how none of them did
  // (tripl-oxkt.14).
  const updateDestinationMut = useMutation({
    mutationFn: (data: { enabled?: boolean }) =>
      alertingApi.updateDestination(slug, destination.id, data),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
  })

  const createRuleMut = useMutation({
    mutationFn: () => alertingApi.createRule(slug, destination.id, ruleFormToPayload(ruleForm)),
    onSuccess: () => {
      invalidateAlertingConfig(qc, slug)
      closeRuleDialog()
      setRuleForm(defaultRuleForm())
      // A created rule lands the alerting chapter's step — inert outside the
      // demo scenario (the reducer drops every other step).
      notifyStepCompleted('alerting/create-rule')
    },
  })

  const updateRuleMut = useMutation({
    mutationFn: () => {
      if (!editingRule) throw new Error('Missing rule')
      return alertingApi.updateRule(slug, destination.id, editingRule.id, ruleFormToPayload(ruleForm))
    },
    onSuccess: () => {
      invalidateAlertingConfig(qc, slug)
      closeRuleDialog()
      setRuleForm(defaultRuleForm())
    },
  })

  const deleteRuleMut = useMutation({
    mutationFn: (ruleId: string) => alertingApi.deleteRule(slug, destination.id, ruleId),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
  })

  // The rule's enable switch was `updateRule(...).then(...)` with no catch and
  // no pending state — the one write on this page that escaped the global
  // mutation error toast, and turning a rule off mid-storm is exactly when "I
  // clicked it and nothing happened" costs most (tripl-oxkt.18).
  const toggleRuleMut = useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      alertingApi.updateRule(slug, destination.id, ruleId, { enabled }),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
  })

  // A test send is deliberately NOT invalidating the destinations list: the
  // backend records it in the audit log rather than as an AlertDelivery, so the
  // counts on this card do not move and a refetch would only throw away the
  // answer the operator is reading.
  const testDestinationMut = useMutation({
    mutationFn: () => alertingApi.testDestination(slug, destination.id),
  })

  const openNewRule = () => {
    setEditingRule(null)
    setRuleForm(defaultRuleForm())
    setRuleDialogOpen(true)
  }

  /**
   * Close the rule dialog, by any of its three exits.
   *
   * Also reports the auto-open instruction as spent: the latch above only holds
   * for the life of THIS card, and the destinations section unmounts every time
   * the reader visits another tab — so without telling the page, coming back
   * would open the rule form again on a destination that already has one
   * (tripl-oxkt.15). Harmless on the ordinary path: the page state is already
   * null and React bails out on an unchanged value.
   */
  const closeRuleDialog = () => {
    setRuleDialogOpen(false)
    setEditingRule(null)
    onAutoOpenRuleConsumed?.()
  }

  const openEditRule = (rule: AlertRule) => {
    setEditingRule(rule)
    setRuleForm(ruleToForm(rule))
    setRuleDialogOpen(true)
  }

  const handleDeleteRule = async (rule: AlertRule) => {
    const ok = await confirm({
      title: 'Delete alert rule',
      message: `Delete "${rule.name}"? ${describeDeletionImpact(rule.total_deliveries, rule.incident_count)}`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteRuleMut.mutate(rule.id)
  }

  const ruleMutation = editingRule ? updateRuleMut : createRuleMut
  const testResult = testDestinationMut.data ?? null

  return (
    <>
      {dialog}
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
                  this card, and the two are opposite facts (tripl-oxkt.17). */}
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
                onClick={() => testDestinationMut.mutate()}
                disabled={testDestinationMut.isPending}
                aria-label={`Send a test message through ${destination.name}`}
              >
                <Send aria-hidden="true" className="mr-2 h-4 w-4" />
                {testDestinationMut.isPending ? 'Sending…' : 'Test'}
              </Button>
              {/* Same contract as the rule switch below: `checked` is the
                  server's value, and the control is inert while its own write
                  is in flight, so a second click cannot queue a write against
                  a state that has not landed yet. */}
              <Switch
                checked={destination.enabled}
                disabled={updateDestinationMut.isPending}
                onCheckedChange={checked => updateDestinationMut.mutate({ enabled: checked })}
                aria-label={`Toggle ${destination.name}`}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit destination ${destination.name}`} onClick={() => onEditDestination(destination)}>
                <Pencil aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            )}
          </div>

          {/* A channel refusal arrives as a 200 with `ok: false` — it is the
              answer the button was pressed for, so it renders as a result and
              not as a crash. Only a transport failure gets `role="alert"`. */}
          {(testDestinationMut.isPending || testResult || testDestinationMut.isError) && (
            <p
              role={testDestinationMut.isError ? 'alert' : 'status'}
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
              {!testDestinationMut.isPending && !testResult && testDestinationMut.isError && (
                `Test send failed: ${getErrorMessage(testDestinationMut.error)}`
              )}
            </p>
          )}

          <div className="flex justify-between items-center">
            <Label className="text-sm">Rules</Label>
            {/* Exactly one card coaches: the local demo sink, where a delivery
                renders locally and nothing external is touched. */}
            {canWrite && (
              <ScenarioCoachMark step="alerting/create-rule" when={!!destination.is_local}>
                <Button size="sm" variant="outline" onClick={openNewRule}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Rule
                </Button>
              </ScenarioCoachMark>
            )}
          </div>

          {destination.rules.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No rules yet.
            </div>
          ) : (
            <div className="space-y-2">
              {destination.rules.map(rule => (
                <div key={rule.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{rule.name}</span>
                        <Badge variant={rule.enabled ? 'default' : 'secondary'} className="text-[10px]">
                          {rule.enabled ? 'enabled' : 'disabled'}
                        </Badge>
                        {/* The mute lives on the rule and is set from the monitor
                            page. This card used to be unable to show it at all,
                            so a snoozed rule read as fully live 200px under a
                            panel that counted it as muted (tripl-oxkt.18). */}
                        {rule.muted && (
                          <Badge variant="warning" className="text-[10px]">
                            {rule.muted_until
                              ? `muted until ${formatDateTime(rule.muted_until)}`
                              : 'muted'}
                          </Badge>
                        )}
                      </div>

                      {/* Delivery health. `Never delivered` is a different fact
                          from `last sent 3h ago`, and until now the card stated
                          neither (tripl-oxkt.17). */}
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {rule.total_deliveries === 0 ? (
                          <span>Never delivered</span>
                        ) : (
                          <>
                            <span>
                              {countOf(rule.total_deliveries, 'delivery', 'deliveries')}
                              {' · '}
                              {countOf(rule.incident_count, 'incident', 'incidents')}
                            </span>
                            <span>last {formatRelativeTime(rule.last_delivery_at)}</span>
                            {rule.last_delivery_status && (
                              <Badge
                                variant={DELIVERY_STATUS_VARIANT[rule.last_delivery_status]}
                                className="text-[10px]"
                              >
                                {rule.last_delivery_status}
                              </Badge>
                            )}
                          </>
                        )}
                        {/* The mute control itself is not duplicated here: one
                            switch in two places is how the two screens started
                            disagreeing. This points at the one that owns it. */}
                        <Link
                          to={`/p/${slug}/monitors/${rule.id}`}
                          className="underline underline-offset-2 hover:text-foreground"
                        >
                          {rule.muted ? 'Change mute →' : 'Mute this rule →'}
                        </Link>
                      </div>

                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
                        <RuleSetting
                          label="Scan"
                          value={rule.scan_config_id
                            ? scans.find(scan => scan.id === rule.scan_config_id)?.name ?? 'unknown scan'
                            : 'all scans'}
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
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      {/* `checked` is the server's value, never local state, so
                          a rejected write cannot leave the switch showing a
                          position the server refused — it simply never moves,
                          and the global mutation toast says why (tripl-oxkt.9,
                          tripl-oxkt.18). Pending is scoped to the ONE rule being
                          written: a card carries several, and a shared flag
                          disables the neighbours for the duration of somebody
                          else's request. */}
                      {canWrite && (
                        <Switch
                          checked={rule.enabled}
                          disabled={
                            toggleRuleMut.isPending && toggleRuleMut.variables?.ruleId === rule.id
                          }
                          onCheckedChange={checked => toggleRuleMut.mutate({ ruleId: rule.id, enabled: checked })}
                          aria-label={`Toggle ${rule.name}`}
                        />
                      )}
                      {/* Exactly one rule coaches the simulate step: the seeded
                          firing rule, whose window is guaranteed to hold anomalies. */}
                      <ScenarioCoachMark
                        step="alerting/simulate"
                        when={rule.name === SCENARIO_SEEDED.firingRuleName}
                      >
                        {/* Labelled, not a bare 32px clock. It is the only control
                            on this page that answers "would a stricter threshold
                            cut the noise" without saving that threshold onto a
                            rule that is live-routing to a real channel — and it
                            was the least visible thing here (tripl-oxkt.17). */}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReplayingRule(rule)}
                          title="Replay this rule over past data, without saving anything"
                          aria-label={`Replay ${rule.name}`}
                        >
                          <History aria-hidden="true" className="mr-2 h-4 w-4" />
                          Replay
                        </Button>
                      </ScenarioCoachMark>
                      {/* Replay stays above, for everyone: it is the one control
                          in this cluster the API does not gate, because it saves
                          nothing — a viewer asking "would a stricter threshold
                          have cut this noise" is asking a question, not making a
                          change (backend alerting.py has no EditorUserDep on
                          /simulate). Edit and delete are both 403s. */}
                      {canWrite && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Edit rule ${rule.name}`} onClick={() => openEditRule(rule)}>
                            <Pencil aria-hidden="true" className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            aria-label={`Delete rule ${rule.name}`}
                            title={`Deletes the rule, ${countOf(rule.total_deliveries, 'delivery', 'deliveries')} and ${countOf(rule.incident_count, 'incident', 'incidents')}`}
                            onClick={() => handleDeleteRule(rule)}
                          >
                            <Trash2 aria-hidden="true" className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Gated on the role as well as on the open flag: `refresh()` can rewrite
          the session mid-visit, and an editor form left open across a demotion
          would still submit its Save. */}
      <Dialog open={canWrite && ruleDialogOpen} onOpenChange={open => { if (!open) closeRuleDialog() }}>
        <DialogContent className="max-w-3xl">
          <form onSubmit={event => { event.preventDefault(); ruleMutation.mutate() }}>
            <DialogHeader>
              <DialogTitle>{editingRule ? 'Edit Alert Rule' : 'New Alert Rule'}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="rule-name">Name</Label>
                  <Input
                    id="rule-name"
                    value={ruleForm.name}
                    onChange={event => setRuleForm(current => ({ ...current, name: event.target.value }))}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rule-cooldown">Cooldown Minutes</Label>
                  <Input
                    id="rule-cooldown"
                    type="number"
                    min={1}
                    value={ruleForm.cooldown_minutes}
                    onChange={event => setRuleForm(current => ({ ...current, cooldown_minutes: Number(event.target.value) }))}
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="rule-scan">Scan</Label>
                <Select
                  value={ruleForm.scan_config_id || ALL_SCANS_OPTION}
                  onValueChange={value => setRuleForm(current => ({
                    ...current,
                    scan_config_id: value === ALL_SCANS_OPTION ? '' : value,
                  }))}
                >
                  <SelectTrigger id="rule-scan"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_SCANS_OPTION}>All scans</SelectItem>
                    {scans.map(scan => (
                      <SelectItem key={scan.id} value={scan.id}>
                        {scan.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {ruleForm.scan_config_id
                    ? 'Only signals from this scan reach the destination. Catalog metric anomalies are project-wide, so they are not delivered by a scan-bound rule.'
                    : 'Signals from every scan in the project reach the destination.'}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_project_total}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_project_total: !!checked }))}
                  />
                  Project total
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_event_types}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_event_types: !!checked }))}
                  />
                  Event types
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_events}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_events: !!checked }))}
                  />
                  Events
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_schema_drifts}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_schema_drifts: !!checked }))}
                  />
                  Schema drift
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_distribution_drifts}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_distribution_drifts: !!checked }))}
                  />
                  Distribution
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_release_regressions}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_release_regressions: !!checked }))}
                  />
                  Release regressions
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_variable_value_drifts}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_variable_value_drifts: !!checked }))}
                  />
                  Value drift
                </label>
                {/* Catalog metrics are a scope of their own: detection has always
                    run on them, but without this box no rule could route the
                    resulting signal anywhere (tripl-jfm3.108). */}
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.include_metrics}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, include_metrics: !!checked }))}
                  />
                  Metrics
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.notify_on_spike}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, notify_on_spike: !!checked }))}
                  />
                  Up only
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.notify_on_drop}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, notify_on_drop: !!checked }))}
                  />
                  Down only
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.enabled}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, enabled: !!checked }))}
                  />
                  Rule enabled
                </label>
              </div>

              <div className="grid grid-cols-1 gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={ruleForm.ai_explanation_enabled}
                    onCheckedChange={checked => setRuleForm(current => ({ ...current, ai_explanation_enabled: !!checked }))}
                  />
                  AI explanation
                </label>
                <p className="text-xs text-muted-foreground">
                  LLM summary appended to alert messages (requires AI enabled on server)
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="rule-min-pct">Min Percent Delta</Label>
                  <Input
                    id="rule-min-pct"
                    type="number"
                    min={0}
                    step="0.1"
                    value={ruleForm.min_percent_delta}
                    onChange={event => setRuleForm(current => ({ ...current, min_percent_delta: Number(event.target.value) }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rule-min-abs">Min Absolute Delta</Label>
                  <Input
                    id="rule-min-abs"
                    type="number"
                    min={0}
                    step="0.1"
                    value={ruleForm.min_absolute_delta}
                    onChange={event => setRuleForm(current => ({ ...current, min_absolute_delta: Number(event.target.value) }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rule-min-expected">Min Expected Count</Label>
                  <Input
                    id="rule-min-expected"
                    type="number"
                    min={0}
                    step="0.1"
                    value={ruleForm.min_expected_count}
                    onChange={event => setRuleForm(current => ({ ...current, min_expected_count: Number(event.target.value) }))}
                  />
                </div>
              </div>

              <TemplateEditor
                destinationType={destination.type}
                messageFormat={ruleForm.message_format}
                onMessageFormatChange={message_format =>
                  setRuleForm(current => {
                    const shouldResetTemplate =
                      !normalizeRuleTemplate(current.message_template)
                      || isDefaultMessageTemplate(current.message_template, current.message_format)
                    const shouldResetItemsTemplate =
                      !normalizeRuleTemplate(current.items_template)
                      || isDefaultItemsTemplate(current.items_template, current.message_format)
                    return {
                      ...current,
                      message_format,
                      message_template: shouldResetTemplate
                        ? getDefaultMessageTemplate(message_format)
                        : current.message_template,
                      items_template: shouldResetItemsTemplate
                        ? getDefaultItemsTemplate(message_format)
                        : current.items_template,
                    }
                  })
                }
                title="Message Template"
                variableOptions={TEMPLATE_VARIABLE_OPTIONS}
                helperText="Type ${var} to get variable suggestions. Use ${items_text} to render the full matched alert list generated from Item Template."
                placeholder={getDefaultMessageTemplate(ruleForm.message_format)}
                value={ruleForm.message_template}
                onChange={message_template => setRuleForm(current => ({ ...current, message_template }))}
              />

              <TemplateEditor
                destinationType={destination.type}
                messageFormat={ruleForm.message_format}
                onMessageFormatChange={() => {}}
                title="Items Template"
                variableOptions={ITEM_TEMPLATE_VARIABLE_OPTIONS}
                helperText="This template is rendered for each matched alert item and then joined into ${items_text}. Use ${details_line}, ${monitoring_line}, and ${drift_line} for optional context lines."
                showFormatSelector={false}
                placeholder={getDefaultItemsTemplate(ruleForm.message_format)}
                value={ruleForm.items_template}
                onChange={items_template => setRuleForm(current => ({ ...current, items_template }))}
              />

              <FilterEditor
                filters={ruleForm.filters}
                eventTypes={eventTypes}
                slug={slug}
                onChange={filters => setRuleForm(current => ({ ...current, filters }))}
              />

              {ruleMutation.isError && (
                <p role="alert" className="text-sm text-destructive">{getErrorMessage(ruleMutation.error)}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeRuleDialog}>Cancel</Button>
              <Button type="submit" disabled={ruleMutation.isPending}>
                {editingRule ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {replayingRule && (
        <RuleReplayDialog
          open={!!replayingRule}
          onOpenChange={(value) => { if (!value) setReplayingRule(null) }}
          slug={slug}
          destinationId={destination.id}
          rule={replayingRule}
        />
      )}
    </>
  )
}
