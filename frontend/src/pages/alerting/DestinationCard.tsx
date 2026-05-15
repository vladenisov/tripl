import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { History, Pencil, Plus, Trash2 } from "lucide-react"
import type {
  AlertDestination,
  AlertRule,
  EventListItem,
  EventType,
} from "@/types"
import { alertingApi } from "@/api/alerting"
import { useConfirm } from "@/hooks/useConfirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { FilterEditor } from "./FilterEditor"
import { RuleReplayDialog } from "./RuleReplayDialog"
import { TemplateEditor } from "./TemplateEditor"
import {
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

export function DestinationCard({
  slug,
  destination,
  eventTypes,
  events,
  onEditDestination,
}: {
  slug: string
  destination: AlertDestination
  eventTypes: EventType[]
  events: EventListItem[]
  onEditDestination: (destination: AlertDestination) => void
}) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null)
  const [replayingRule, setReplayingRule] = useState<AlertRule | null>(null)
  const [ruleForm, setRuleForm] = useState<RuleFormState>(defaultRuleForm())

  const updateDestinationMut = useMutation({
    mutationFn: (data: { enabled?: boolean }) =>
      alertingApi.updateDestination(slug, destination.id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alertDestinations', slug] }),
  })

  const createRuleMut = useMutation({
    mutationFn: () => alertingApi.createRule(slug, destination.id, ruleFormToPayload(ruleForm)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alertDestinations', slug] })
      setRuleDialogOpen(false)
      setEditingRule(null)
      setRuleForm(defaultRuleForm())
    },
  })

  const updateRuleMut = useMutation({
    mutationFn: () => {
      if (!editingRule) throw new Error('Missing rule')
      return alertingApi.updateRule(slug, destination.id, editingRule.id, ruleFormToPayload(ruleForm))
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alertDestinations', slug] })
      setRuleDialogOpen(false)
      setEditingRule(null)
      setRuleForm(defaultRuleForm())
    },
  })

  const deleteRuleMut = useMutation({
    mutationFn: (ruleId: string) => alertingApi.deleteRule(slug, destination.id, ruleId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alertDestinations', slug] }),
  })

  const openNewRule = () => {
    setEditingRule(null)
    setRuleForm(defaultRuleForm())
    setRuleDialogOpen(true)
  }

  const openEditRule = (rule: AlertRule) => {
    setEditingRule(rule)
    setRuleForm(ruleToForm(rule))
    setRuleDialogOpen(true)
  }

  const handleDeleteRule = async (rule: AlertRule) => {
    const ok = await confirm({
      title: 'Delete alert rule',
      message: `Delete "${rule.name}"?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteRuleMut.mutate(rule.id)
  }

  const ruleMutation = editingRule ? updateRuleMut : createRuleMut

  return (
    <>
      {dialog}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{destination.name}</span>
                <Badge variant="outline" className="uppercase text-[10px]">
                  {destination.type}
                </Badge>
                <Badge variant={destination.enabled ? 'default' : 'secondary'} className="text-[10px]">
                  {destination.enabled ? 'enabled' : 'disabled'}
                </Badge>
                {destination.type === 'slack' && destination.webhook_set && (
                  <Badge variant="outline" className="text-[10px]">webhook set</Badge>
                )}
                {destination.type === 'telegram' && destination.bot_token_set && (
                  <Badge variant="outline" className="text-[10px]">bot token set</Badge>
                )}
                {destination.type === 'telegram' && destination.chat_id && (
                  <Badge variant="outline" className="text-[10px]">chat {destination.chat_id}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {destination.rules.length} rule{destination.rules.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={destination.enabled}
                onCheckedChange={checked => updateDestinationMut.mutate({ enabled: checked })}
                aria-label={`Toggle ${destination.name}`}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEditDestination(destination)}>
                <Pencil className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="flex justify-between items-center">
            <Label className="text-sm">Rules</Label>
            <Button size="sm" variant="outline" onClick={openNewRule}>
              <Plus className="mr-2 h-4 w-4" />
              Add Rule
            </Button>
          </div>

          {destination.rules.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No rules yet.
            </div>
          ) : (
            <div className="space-y-2">
              {destination.rules.map(rule => (
                <div key={rule.id} className="rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{rule.name}</span>
                        <Badge variant={rule.enabled ? 'default' : 'secondary'} className="text-[10px]">
                          {rule.enabled ? 'enabled' : 'disabled'}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span>Scopes: {scopeSummary(rule) || 'none'}</span>
                        <span>Direction: {directionSummary(rule) || 'none'}</span>
                        <span>Cooldown: {formatCooldown(rule.cooldown_minutes)}</span>
                        <span>Min %: {rule.min_percent_delta}</span>
                        <span>Min Δ: {rule.min_absolute_delta}</span>
                        <span>Min expected: {rule.min_expected_count}</span>
                        <span>
                          Message: {!rule.message_template || isDefaultMessageTemplate(rule.message_template, rule.message_format)
                            ? `default (${rule.message_format})`
                            : `custom (${rule.message_format})`}
                        </span>
                        {!!rule.filters.length && (
                          <span>{rule.filters.length} filter{rule.filters.length === 1 ? '' : 's'}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={checked => alertingApi.updateRule(slug, destination.id, rule.id, { enabled: checked }).then(() => qc.invalidateQueries({ queryKey: ['alertDestinations', slug] }))}
                        aria-label={`Toggle ${rule.name}`}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setReplayingRule(rule)}
                        title="Replay last N days"
                        aria-label={`Replay ${rule.name}`}
                      >
                        <History className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEditRule(rule)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDeleteRule(rule)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={ruleDialogOpen} onOpenChange={open => { if (!open) { setRuleDialogOpen(false); setEditingRule(null) } }}>
        <DialogContent className="max-w-3xl">
          <form onSubmit={event => { event.preventDefault(); ruleMutation.mutate() }}>
            <DialogHeader>
              <DialogTitle>{editingRule ? 'Edit Alert Rule' : 'New Alert Rule'}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Name</Label>
                  <Input
                    aria-label="Rule Name"
                    value={ruleForm.name}
                    onChange={event => setRuleForm(current => ({ ...current, name: event.target.value }))}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Cooldown Minutes</Label>
                  <Input
                    type="number"
                    min={1}
                    value={ruleForm.cooldown_minutes}
                    onChange={event => setRuleForm(current => ({ ...current, cooldown_minutes: Number(event.target.value) }))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label>Min Percent Delta</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.1"
                    value={ruleForm.min_percent_delta}
                    onChange={event => setRuleForm(current => ({ ...current, min_percent_delta: Number(event.target.value) }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Min Absolute Delta</Label>
                  <Input
                    type="number"
                    min={0}
                    step="0.1"
                    value={ruleForm.min_absolute_delta}
                    onChange={event => setRuleForm(current => ({ ...current, min_absolute_delta: Number(event.target.value) }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Min Expected Count</Label>
                  <Input
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
                helperText="This template is rendered for each matched alert item and then joined into ${items_text}. Use ${details_line} and ${monitoring_line} for optional link lines."
                showFormatSelector={false}
                placeholder={getDefaultItemsTemplate(ruleForm.message_format)}
                value={ruleForm.items_template}
                onChange={items_template => setRuleForm(current => ({ ...current, items_template }))}
              />

              <FilterEditor
                filters={ruleForm.filters}
                eventTypes={eventTypes}
                events={events}
                onChange={filters => setRuleForm(current => ({ ...current, filters }))}
              />

              {ruleMutation.isError && (
                <p className="text-sm text-destructive">{(ruleMutation.error as Error).message}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRuleDialogOpen(false)}>Cancel</Button>
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
