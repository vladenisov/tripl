import { useState, type Dispatch, type SetStateAction } from "react"
import { History } from "lucide-react"

import { MAX_ALERT_RULE_NAME_LENGTH } from "@/api/alerting"
import type { AlertDestination, AlertScopeReadiness, EventType, ScanConfig } from "@/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useDirtySinceOpen, useUnsavedDialogGuard } from "@/hooks/useUnsavedChangesGuard"

import { FieldError } from "./FieldError"
import { fieldErrorProps, splitApiFieldErrors } from "./fieldErrors"
import { FilterEditor } from "./FilterEditor"
import { InertScopeNotice } from "./InertScopeNotice"
import { TemplateEditor } from "./TemplateEditor"
import {
  ALL_SCANS_OPTION,
  ITEM_TEMPLATE_VARIABLE_OPTIONS,
  TEMPLATE_VARIABLE_OPTIONS,
  getDefaultItemsTemplate,
  getDefaultMessageTemplate,
  hasRuleFormProblems,
  ruleFormProblems,
  withMessageFormat,
  type RuleFormState,
  type RuleNumericField,
} from "./constants"

/** The payload keys the form has an input (or a group) for. */
const RULE_FORM_FIELDS = [
  'name',
  'cooldown_minutes',
  'min_percent_delta',
  'min_absolute_delta',
  'min_expected_count',
  'message_format',
  'message_template',
  'items_template',
  'filters',
] as const

/** Human names for what a leftover server error may point at. */
const RULE_FIELD_LABELS: Readonly<Record<string, string>> = {
  scan_config_id: 'Scan',
  notify_on_spike: 'Spikes',
  notify_on_drop: 'Drops',
  enabled: 'Rule enabled',
  ai_explanation_enabled: 'AI explanation',
}

/** One numeric setting: its input id, label, and the step it moves in. */
const NUMERIC_INPUTS: readonly {
  field: RuleNumericField
  id: string
  label: string
  min: number
  step: string
}[] = [
  { field: 'min_percent_delta', id: 'rule-min-pct', label: 'Min percent delta', min: 0, step: '0.1' },
  { field: 'min_absolute_delta', id: 'rule-min-abs', label: 'Min absolute delta', min: 0, step: '0.1' },
  { field: 'min_expected_count', id: 'rule-min-expected', label: 'Min expected count', min: 0, step: '0.1' },
]

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
  /** Whether `scans` has answered; until then a bound scan is loading, not blank. */
  scansLoaded?: boolean
  /** The scan list failed to load; a bound scan is unavailable, not loading. */
  scansFailed?: boolean
  /**
   * Replay the rule as SAVED, from inside the editor. Only offered while
   * editing — a rule that does not exist yet has nothing to replay.
   */
  onReplaySaved?: () => void
  /**
   * Whether the two drift scopes have any source data in this project.
   * Optional because it rides along on the monitors-summary response: while
   * that request is in flight there is no answer yet, and a form must not
   * accuse a project on the strength of a value it does not have.
   */
  scopeReadiness?: AlertScopeReadiness
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
  scansLoaded = true,
  scansFailed = false,
  onReplaySaved,
  scopeReadiness,
  onSubmit,
  isPending,
  isError,
  error,
}: RuleEditorDialogProps) {
  // Drives the format choices, which differ per channel. No fallback: before a
  // destination is picked there is no channel, and offering the FIRST
  // destination's formats showed choices for a channel nobody chose (ALR-4).
  const destinationType =
    destinations.find(destination => destination.id === destinationId)?.type ?? null

  // Problems the form can see for itself, named beside their inputs instead of
  // coming back as a raw 422 — or not coming back at all (ALR-5, ALR-14,
  // ALR-15, ALR-16). Scope and direction speak up at once: unticking the last
  // box is the whole mistake. The rest wait for a submit, so a filter row
  // just added is not an error before anyone has had a chance to fill it.
  const problems = ruleFormProblems(ruleForm)
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [openedFor, setOpenedFor] = useState(open)
  if (openedFor !== open) {
    setOpenedFor(open)
    if (open) setSubmitAttempted(false)
  }
  const server = splitApiFieldErrors(isError ? error : null, RULE_FORM_FIELDS, RULE_FIELD_LABELS)
  const numericError = (field: RuleNumericField) =>
    (submitAttempted ? problems.numeric[field] : undefined) ?? server.fields[field]
  const hasShownProblems =
    problems.scopes !== null
    || problems.direction !== null
    || (submitAttempted && hasRuleFormProblems(problems))
  const submit = () => {
    setSubmitAttempted(true)
    if (hasRuleFormProblems(problems)) return
    onSubmit()
  }

  // `=== false` rather than `!`: an absent or still-in-flight readiness must
  // render NOTHING. The form would otherwise accuse a project on the strength
  // of a value it does not have yet (tripl-wkwv.1).
  const distributionIsInert =
    ruleForm.include_distribution_drifts && scopeReadiness?.distribution_drift === false
  const valueDriftIsInert =
    ruleForm.include_variable_value_drifts && scopeReadiness?.variable_value_drift === false

  // Two 8-row templates, filters and thresholds: Escape, a stray overlay click
  // or Cancel used to drop all of it at once (ALR-17). They ask first now,
  // while the form differs from what it opened with.
  const unsaved = useUnsavedDialogGuard(useDirtySinceOpen(open, { ruleForm, destinationId }))
  const requestClose = () => unsaved.requestClose(onClose)

  return (
    <>
    {unsaved.dialog}
    <Dialog open={open} onOpenChange={value => { if (!value) requestClose() }}>
      <DialogContent
        className="max-w-3xl"
        // An open variable-suggestion list takes Escape first: TemplateEditor
        // closes it, and the form stays (ALR-19). Radix listens for Escape on
        // the document before the textarea's own handler runs, so the dialog
        // has to be told here.
        onEscapeKeyDown={event => {
          const target = event.target
          if (
            target instanceof HTMLElement
            && target.getAttribute('role') === 'combobox'
            && target.getAttribute('aria-expanded') === 'true'
          ) {
            event.preventDefault()
          }
        }}
      >
        <form onSubmit={event => { event.preventDefault(); submit() }}>
          <DialogHeader>
            <DialogTitle>{isEditing ? 'Edit Alert Rule' : 'New Alert Rule'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="rule-name">Name</Label>
                <Input
                  id="rule-name"
                  maxLength={MAX_ALERT_RULE_NAME_LENGTH}
                  value={ruleForm.name}
                  onChange={event => setRuleForm(current => ({ ...current, name: event.target.value }))}
                  required
                  {...fieldErrorProps('rule-name', server.fields.name)}
                />
                <FieldError inputId="rule-name" message={server.fields.name} />
              </div>
              {/* The text in the box, not `Number(text)`: an emptied field
                  read back as "0" and could not be cleared to retype, and a
                  cleared cooldown saved as 0, which the API refuses (ALR-16).
                  No `required`: an empty box is refused by `ruleFormProblems`
                  with a message beside it, where the browser's own bubble
                  would stop the submit before the form could say anything. */}
              <div className="grid gap-2">
                <Label htmlFor="rule-cooldown">Cooldown minutes</Label>
                <Input
                  id="rule-cooldown"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={ruleForm.cooldown_minutes}
                  onChange={event => setRuleForm(current => ({ ...current, cooldown_minutes: event.target.value }))}
                  {...fieldErrorProps('rule-cooldown', numericError('cooldown_minutes'))}
                />
                <FieldError inputId="rule-cooldown" message={numericError('cooldown_minutes')} />
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
              {isEditing && onReplaySaved && (
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={onReplaySaved}>
                    <History aria-hidden="true" className="mr-2 h-4 w-4" />
                    Replay saved rule
                  </Button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Replays the rule as it is saved now, not the edits on this form.
                  </p>
                </div>
              )}
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
                  {/* The bound scan's name is not known until the list
                      answers; say so rather than render a blank trigger
                      (ALR-47). */}
                  {!scansLoaded
                    && ruleForm.scan_config_id
                    && !scans.some(scan => scan.id === ruleForm.scan_config_id) && (
                    <SelectItem value={ruleForm.scan_config_id} disabled>
                      {scansFailed ? 'Scan unavailable (scan list failed to load)' : 'Loading scans…'}
                    </SelectItem>
                  )}
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

            <fieldset
              className="grid gap-2"
              aria-describedby={problems.scopes ? 'rule-scopes-error' : undefined}
            >
            <legend className="mb-2 text-sm font-medium">Signals</legend>
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
            {problems.scopes && (
              <p id="rule-scopes-error" className="text-xs text-destructive">{problems.scopes}</p>
            )}
            </fieldset>

            {/* The boxes above stay ENABLED while these notices are up. The
                precondition can be satisfied later, and locking the toggle
                would make the problem unfixable from the one screen that
                reports it — the reader would be told what is wrong and denied
                the switch.

                `newTab` is set here and on no other caller: the draft around
                these notices is component state that no exit preserves, so a
                same-tab link would discard a half-built rule the moment the
                reader acted on what the notice told them (tripl-wkwv.1). */}
            {(distributionIsInert || valueDriftIsInert) && (
              <div className="grid gap-2">
                {distributionIsInert && (
                  <InertScopeNotice slug={slug} scope="distribution_drift" newTab />
                )}
                {valueDriftIsInert && (
                  <InertScopeNotice slug={slug} scope="variable_value_drift" newTab />
                )}
              </div>
            )}

            {/* Two independent switches, labelled as such. They read "Up only"
                and "Down only" while both started ticked — a contradiction —
                and unticking both saved a rule the API refused (ALR-14). */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <fieldset
                className="md:col-span-2"
                aria-describedby={problems.direction ? 'rule-direction-error' : undefined}
              >
                <legend className="mb-2 text-sm font-medium">Notify on</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={ruleForm.notify_on_spike}
                      onCheckedChange={checked => setRuleForm(current => ({ ...current, notify_on_spike: !!checked }))}
                    />
                    Spikes (up)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={ruleForm.notify_on_drop}
                      onCheckedChange={checked => setRuleForm(current => ({ ...current, notify_on_drop: !!checked }))}
                    />
                    Drops (down)
                  </label>
                </div>
                {problems.direction && (
                  <p id="rule-direction-error" className="mt-2 text-xs text-destructive">{problems.direction}</p>
                )}
              </fieldset>
              <label className="flex items-center gap-2 self-end text-sm">
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
              {NUMERIC_INPUTS.map(({ field, id, label, min, step }) => (
                <div key={field} className="grid gap-2">
                  <Label htmlFor={id}>{label}</Label>
                  <Input
                    id={id}
                    type="number"
                    inputMode="decimal"
                    min={min}
                    step={step}
                    value={ruleForm[field]}
                    onChange={event => setRuleForm(current => ({ ...current, [field]: event.target.value }))}
                    {...fieldErrorProps(id, numericError(field))}
                  />
                  <FieldError inputId={id} message={numericError(field)} />
                </div>
              ))}
            </div>

            <TemplateEditor
              destinationType={destinationType}
              messageFormat={ruleForm.message_format}
              onMessageFormatChange={message_format =>
                setRuleForm(current => withMessageFormat(current, message_format))
              }
              title="Message Template"
              variableOptions={TEMPLATE_VARIABLE_OPTIONS}
              helperText="Type ${var} to get variable suggestions. Use ${items_text} to render the full matched alert list generated from Item Template."
              placeholder={getDefaultMessageTemplate(ruleForm.message_format)}
              value={ruleForm.message_template}
              onChange={message_template => setRuleForm(current => ({ ...current, message_template }))}
              error={server.fields.message_template ?? server.fields.message_format}
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
              error={server.fields.items_template}
            />

            <FilterEditor
              filters={ruleForm.filters}
              eventTypes={eventTypes}
              slug={slug}
              onChange={filters => setRuleForm(current => ({ ...current, filters }))}
              rowErrors={submitAttempted ? problems.filters : {}}
              error={server.fields.filters}
            />

            {/* One announced line: the per-field messages above are not live
                regions, so a refused submit would otherwise change nothing a
                screen reader says. */}
            {(server.message || (submitAttempted && hasShownProblems) || Object.keys(server.fields).length > 0) && (
              <p role="alert" className="text-sm text-destructive">
                {server.message ?? 'Check the highlighted fields.'}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={requestClose}>Cancel</Button>
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
    </>
  )
}
