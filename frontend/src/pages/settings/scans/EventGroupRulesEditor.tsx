import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { EventGroupRule, ScanConfigPreview } from '@/types'
import type { UiEventGroupCondition, UiEventGroupRule } from './scanFormTypes'
import { emptyGroupCondition, emptyGroupRule } from './scanFormTypes'

export function EventGroupRulesEditor({
  rules,
  columns,
  onChange,
}: {
  rules: UiEventGroupRule[]
  columns?: ScanConfigPreview['columns']
  onChange: (rules: UiEventGroupRule[]) => void
}) {
  const fieldOptions = Array.from(
    new Set([
      'event_name',
      '__event_name',
      ...(columns ?? []).map(column => column.name),
      ...rules.flatMap(rule => rule.conditions.map(condition => condition.field).filter(Boolean)),
    ]),
  )

  const updateRule = (index: number, patch: Partial<UiEventGroupRule>) => {
    onChange(rules.map((rule, ruleIndex) => (
      ruleIndex === index ? { ...rule, ...patch } : rule
    )))
  }

  const updateCondition = (
    ruleIndex: number,
    conditionIndex: number,
    patch: Partial<UiEventGroupCondition>,
  ) => {
    onChange(rules.map((rule, currentRuleIndex) => {
      if (currentRuleIndex !== ruleIndex) return rule
      return {
        ...rule,
        conditions: rule.conditions.map((condition, currentConditionIndex) => (
          currentConditionIndex === conditionIndex ? { ...condition, ...patch } : condition
        )),
      }
    }))
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Event groups</div>
          {!columns?.length && (
            <p className="text-xs text-muted-foreground">
              Load a preview to pick real columns; only event_name is available otherwise.
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...rules, emptyGroupRule()])}
        >
          <Plus className="mr-2 h-3 w-3" />Add Group Rule
        </Button>
      </div>
      {rules.length === 0 && (
        <p className="text-xs text-muted-foreground">No grouping rules.</p>
      )}
      {rules.map((rule, ruleIndex) => (
        <div key={rule._uid} className="space-y-3 rounded-md border bg-background p-3">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
            <div className="grid gap-1">
              <Label>Group name</Label>
              <Input
                value={rule.name}
                onChange={event => updateRule(ruleIndex, { name: event.target.value })}
                placeholder="button events"
              />
            </div>
            <div className="grid gap-1">
              <Label>Match</Label>
              <select
                value={rule.condition_logic}
                onChange={event => updateRule(ruleIndex, {
                  condition_logic: event.target.value as EventGroupRule['condition_logic'],
                })}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="all">All</option>
                <option value="any">Any</option>
              </select>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="self-end text-muted-foreground hover:text-destructive"
              title="Remove group rule"
              onClick={() => onChange(rules.filter((_, index) => index !== ruleIndex))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <div className="space-y-2">
            {rule.conditions.map((condition, conditionIndex) => (
              <div key={condition._uid} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <div className="grid gap-1">
                  <Label>Field</Label>
                  <select
                    value={condition.field}
                    onChange={event => updateCondition(ruleIndex, conditionIndex, {
                      field: event.target.value,
                    })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  >
                    {fieldOptions.map(field => (
                      <option key={field} value={field}>{field}</option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-1">
                  <Label>Regex</Label>
                  <Input
                    value={condition.pattern}
                    onChange={event => updateCondition(ruleIndex, conditionIndex, {
                      pattern: event.target.value,
                    })}
                    placeholder="^button:"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="self-end text-muted-foreground hover:text-destructive"
                  title="Remove condition"
                  disabled={rule.conditions.length === 1}
                  onClick={() => updateRule(ruleIndex, {
                    conditions: rule.conditions.filter((_, index) => index !== conditionIndex),
                  })}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => updateRule(ruleIndex, {
                conditions: [...rule.conditions, emptyGroupCondition()],
              })}
            >
              <Plus className="mr-2 h-3 w-3" />Add Condition
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
