import type { Dispatch, SetStateAction } from "react"

import type { AlertDestination, EventType, ScanConfig } from "@/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getErrorMessage } from "@/lib/utils"

import { FilterEditor } from "./FilterEditor"
import { TemplateEditor } from "./TemplateEditor"
import {
  ALL_SCANS_OPTION,
  ITEM_TEMPLATE_VARIABLE_OPTIONS,
  TEMPLATE_VARIABLE_OPTIONS,
  getDefaultItemsTemplate,
  getDefaultMessageTemplate,
  isDefaultItemsTemplate,
  isDefaultMessageTemplate,
  normalizeRuleTemplate,
  type RuleFormState,
} from "./constants"

interface RuleEditorDialogProps {
  open: boolean
  onClose: () => void
  slug: string
  destinations: AlertDestination[]
  /** Which destination the rule routes to. Fixed once the rule exists — see below. */
  destinationId: string
  onDestinationIdChange: (destinationId: string) => void
  /** False while creating; drives the title, the verb, and the picker's lock. */
  isEditing: boolean
  ruleForm: RuleFormState
  setRuleForm: Dispatch<SetStateAction<RuleFormState>>
  eventTypes: EventType[]
  scans: ScanConfig[]
  onSubmit: () => void
  isPending: boolean
  isError: boolean
  error: unknown
}

/**
 * The alert-rule form.
 *
 * It used to live inside `DestinationCard`, which is why it never asked which
 * destination the rule routes to — the card it was rendered in answered that.
 * Now that rules are their own section (tripl-89ps) the question has to be on
 * the form, and it is the first field after the name: a rule with no
 * destination delivers nowhere, and it is the one setting here with no sensible
 * default.
 *
 * The picker is disabled while editing. `updateRule` addresses a rule THROUGH
 * its destination (`/destinations/{id}/rules/{id}`), so re-pointing an existing
 * rule is not an edit the API can express — it would be a delete and a create,
 * silently dropping the rule's delivery history. Offering a control that cannot
 * keep its promise is worse than not offering it.
 */
export function RuleEditorDialog({
  open,
  onClose,
  slug,
  destinations,
  destinationId,
  onDestinationIdChange,
  isEditing,
  ruleForm,
  setRuleForm,
  eventTypes,
  scans,
  onSubmit,
  isPending,
  isError,
  error,
}: RuleEditorDialogProps) {
  // Drives the template previews, which render differently per channel. Falls
  // back to the first destination for the window before one is picked, so the
  // editor never renders against `undefined`.
  const destinationType =
    destinations.find(destination => destination.id === destinationId)?.type
    ?? destinations[0]?.type
    ?? 'slack'

  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
      <DialogContent className="max-w-3xl">
        <form onSubmit={event => { event.preventDefault(); onSubmit() }}>
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit Alert Rule' : 'New Alert Rule'}</DialogTitle>
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
                <Label htmlFor="rule-cooldown">Cooldown minutes</Label>
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
              <Label htmlFor="rule-destination">Destination</Label>
              <Select
                value={destinationId}
                onValueChange={onDestinationIdChange}
                disabled={isEditing}
              >
                <SelectTrigger id="rule-destination">
                  <SelectValue placeholder="Pick a destination" />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map(destination => (
                    <SelectItem key={destination.id} value={destination.id}>
                      {destination.name} · {destination.type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {isEditing
                  ? 'A rule cannot be re-pointed at another destination — that would drop its delivery history. Create a new rule instead.'
                  : 'Where matched signals are delivered.'}
              </p>
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

            {/* Sentence case, like every other label in this app — here, and on
                the Cooldown minutes field above. `min_expected_count` is the
                same setting Detection settings labels "Min expected count"
                (settings/MonitoringTab.tsx) and the monitor and replay surfaces
                label "Min expected" (MonitorsSection, RuleReplayDialog); this
                dialog was the last place still spelling it in Title Case, so
                one dial was named two ways depending on which surface you
                reached it from. Its two neighbours are re-cased with it: three
                fields in one row, two of them Title Case, would read as two
                forms glued together. */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="rule-min-pct">Min percent delta</Label>
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
                <Label htmlFor="rule-min-abs">Min absolute delta</Label>
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
                <Label htmlFor="rule-min-expected">Min expected count</Label>
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
              destinationType={destinationType}
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
              destinationType={destinationType}
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

            {isError && (
              <p role="alert" className="text-sm text-destructive">{getErrorMessage(error)}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            {/* A rule with no destination cannot be created: the API addresses
                the rule through it, so submitting would 404 on a path segment
                the reader never saw. */}
            <Button type="submit" disabled={isPending || !destinationId}>
              {isEditing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
