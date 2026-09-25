/**
 * The sections of the single-event form below Details, split out of
 * `EventForm.tsx` along the seams the form already had (EVT-30). State stays
 * with the form — a save reads all of it — and each card renders one part.
 */
import type { Event as TEvent, FieldDefinition, MetaFieldDefinition, Variable } from '@/types'
import { X } from 'lucide-react'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import type { ScenarioStepId } from '@/demo/scenarioModel'
import { useActiveBranchId, useBranchLinkProps } from '@/hooks/useBranch'
import { EvField, EvInput, SurfCard } from './eventFormLayout'
import {
  FieldBreakdownLink,
  FieldTemplateHints,
  FieldValueControl,
  MetaFieldControl,
  ScanMaintenanceNotice,
} from './eventFormFields'

export function TagsBreakdownsCard({
  tags,
  onTagsChange,
  tagInput,
  onTagInputChange,
  onCommitTag,
  breakdownOptions,
  breakdownColumns,
  onToggleBreakdown,
  breakdownInput,
  onBreakdownInputChange,
  onCommitBreakdown,
}: {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  tagInput: string
  onTagInputChange: (value: string) => void
  /** Adds what is in the tag input as a chip and clears the input. */
  onCommitTag: () => void
  breakdownOptions: string[]
  breakdownColumns: string[]
  onToggleBreakdown: (column: string) => void
  breakdownInput: string
  onBreakdownInputChange: (value: string) => void
  /** Adds what is in the column input (never removes) and clears it. */
  onCommitBreakdown: () => void
}) {
  return (
    <SurfCard title="Tags & breakdowns">
      <EvField label="Tags" htmlFor="form-tags" hint="Press Enter or comma to add. Anything left typed is added on save.">
        {tags.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-[6px]">
            {tags.map(t => (
              <span
                key={t}
                className="inline-flex h-[22px] items-center gap-[5px] rounded-full pl-[9px] pr-[6px] text-[11.5px]"
                style={{ background: 'var(--surface-hover)' }}
              >
                {t}
                <button
                  type="button"
                  onClick={() => onTagsChange(tags.filter(x => x !== t))}
                  className="flex transition-colors hover:text-[var(--danger)]"
                  style={{ color: 'var(--fg-subtle)' }}
                  aria-label={`Remove ${t} tag`}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
        <EvInput
          id="form-tags"
          value={tagInput}
          onChange={e => onTagInputChange(e.target.value)}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
              e.preventDefault()
              onCommitTag()
            }
          }}
          // A chip typed and then left used to vanish on save (EVT-26).
          onBlur={() => { if (tagInput.trim()) onCommitTag() }}
          placeholder="Type tag + Enter"
        />
      </EvField>

      <EvField
        label="Metric breakdowns"
        htmlFor="form-breakdown-column"
        hint="Warehouse columns to roll metrics up by."
        last
      >
        <div className="flex flex-wrap gap-[6px]">
          {breakdownOptions.map(c => {
            const on = breakdownColumns.includes(c)
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => onToggleBreakdown(c)}
                className="mono rounded-full px-[9px] py-1 text-[11.5px]"
                style={{
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                  background: on ? 'var(--accent-soft)' : 'var(--bg)',
                  color: on ? 'var(--accent)' : 'var(--fg-muted)',
                }}
              >
                {c}
              </button>
            )
          })}
        </div>
        {/* The other half of what the docs describe, and what the redesign
            dropped: a column the offered set cannot know about — one the
            base query computes, or a scan column no field definition
            covers — is still reachable by typing it. */}
        <EvInput
          id="form-breakdown-column"
          className="mono mt-2"
          value={breakdownInput}
          onChange={e => onBreakdownInputChange(e.target.value)}
          onKeyDown={e => {
            if ((e.key === 'Enter' || e.key === ',') && breakdownInput.trim()) {
              e.preventDefault()
              onToggleBreakdown(breakdownInput.trim())
              onBreakdownInputChange('')
            }
          }}
          onBlur={() => { if (breakdownInput.trim()) onCommitBreakdown() }}
          placeholder="Other column + Enter"
        />
      </EvField>
    </SurfCard>
  )
}

export function FieldValuesCard({
  slug,
  event,
  fields,
  typeLabel,
  nameFormat,
  namingColumns,
  fieldValues,
  onFieldValueChange,
  variables,
  storedFieldValues,
  collectedBreakdownColumns,
  breakdownColumns,
  onToggleBreakdown,
  coachStep,
  coachActive,
}: {
  slug: string
  event: TEvent | null
  fields: FieldDefinition[]
  typeLabel: string
  nameFormat: string | null
  namingColumns: ReadonlySet<string>
  fieldValues: Record<string, string>
  onFieldValueChange: (fieldId: string, value: string) => void
  variables: Variable[]
  storedFieldValues: ReadonlyMap<string, { value: string; isAuthored: boolean }>
  collectedBreakdownColumns: ReadonlySet<string>
  breakdownColumns: string[]
  onToggleBreakdown: (column: string) => void
  coachStep: ScenarioStepId
  coachActive: boolean
}) {
  const branchId = useActiveBranchId()
  const branchLink = useBranchLinkProps()
  if (fields.length === 0) return null
  return (
    <SurfCard
      title="Field values"
      subtitle={
        nameFormat
          ? `From the ${typeLabel} schema. The event name is built from ${[...namingColumns].join(', ')}.`
          : `From the ${typeLabel} schema`
      }
    >
      {fields.map((f, i) => {
        const namesEvent = namingColumns.has(f.name)
        // A naming row is required in practice whatever its schema says:
        // Create stays blocked until it is filled. Marking only `is_required`
        // made the form's own marks disagree with what it enforces — on
        // windy-ios's `se` type none of the three columns that build the name
        // carries the flag (tripl-u2h9.4).
        const required = f.is_required || namesEvent
        const value = fieldValues[f.id] ?? ''
        return (
          <EvField
            key={f.id}
            label={f.display_name}
            htmlFor={`field-${f.id}`}
            required={required}
            hint={
              <>
                <span className="mono">{f.name} · {f.field_type}</span>
                {namesEvent && (
                  <span className="mt-[2px] block" style={{ color: 'var(--accent)' }}>
                    names the event
                  </span>
                )}
              </>
            }
            last={i === fields.length - 1}
            notes={
              <>
                <FieldTemplateHints value={value} variables={variables} namesEvent={namesEvent} slug={slug} />
                <ScanMaintenanceNotice
                  stored={storedFieldValues.get(f.id) ?? null}
                  current={value}
                  onHandBack={required ? undefined : () => onFieldValueChange(f.id, '')}
                />
                {/* A JSON field is not a warehouse column, so it can never be a
                    breakdown — `breakdownOptions` leaves those out too. */}
                {event && f.field_type !== 'json' && (
                  <FieldBreakdownLink
                    column={f.name}
                    href={branchLink(
                      `/p/${slug}/monitoring/event/${event.id}`
                        + `?tab=breakdowns&column=${encodeURIComponent(f.name)}`,
                      branchId,
                    )}
                    state={
                      collectedBreakdownColumns.has(f.name)
                        ? 'collected'
                        : breakdownColumns.includes(f.name)
                          ? 'collecting'
                          : 'off'
                    }
                    onSelect={() => onToggleBreakdown(f.name)}
                  />
                )}
              </>
            }
          >
            {/* The div is the mark's anchor: FieldValueControl is a plain
                function component and would swallow the cloned ref. */}
            <ScenarioCoachMark step={coachStep} when={f.name === SCENARIO_SEEDED.editedFieldName}>
              <div
                className={
                  coachActive && f.name === SCENARIO_SEEDED.editedFieldName ? 'max-w-[320px]' : undefined
                }
              >
                <FieldValueControl
                  field={f}
                  // The label's required mark and the control must agree: a
                  // naming column IS required to create the event, whatever
                  // its schema flag says, and marking one without the other
                  // is how the form came to promise a check nothing ran.
                  requiredOverride={required}
                  inputId={`field-${f.id}`}
                  value={value}
                  onChange={v => onFieldValueChange(f.id, v)}
                  variables={variables}
                />
              </div>
            </ScenarioCoachMark>
          </EvField>
        )
      })}
    </SurfCard>
  )
}

export function MetaFieldsCard({
  metaFields,
  metaValues,
  onMetaValuesChange,
  variables,
}: {
  metaFields: MetaFieldDefinition[]
  metaValues: Record<string, string[]>
  onMetaValuesChange: (metaFieldId: string, values: string[]) => void
  variables: Variable[]
}) {
  if (metaFields.length === 0) return null
  return (
    <SurfCard title="Meta fields">
      {metaFields.map((mf, i) => (
        <EvField
          key={mf.id}
          label={mf.display_name}
          htmlFor={`meta-${mf.id}`}
          required={mf.is_required}
          last={i === metaFields.length - 1}
        >
          <MetaFieldControl
            metaField={mf}
            inputId={`meta-${mf.id}`}
            values={metaValues[mf.id] ?? []}
            onChange={next => onMetaValuesChange(mf.id, next)}
            variables={variables}
          />
        </EvField>
      ))}
    </SurfCard>
  )
}
