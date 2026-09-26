import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { variablesApi } from '@/api/variables'
import { REQUIRED_MESSAGE, focusFirstInvalid } from '@/components/forms/validation'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { projectEventKey, projectEventsKey, variablesKey } from '@/lib/queryKeys'
import type { Variable, VariableType } from '@/types'
import { isValidVariableName, VARIABLE_NAME_RULE_MESSAGE } from '../variablesShared'
import { invalidValuesFor, valueRuleFor } from '../variableValueValidation'

/**
 * The definition draft of ONE variable — name, type, description, documented
 * values and bindings — with its Save.
 *
 * Shared by the quick-edit dialog and the variable page (AU-26), so the two
 * cannot disagree on what a valid edit is. The drafts are seeded once from
 * `variable`; mount the caller keyed by the variable id so a different variable
 * starts on a fresh draft.
 */
export function useVariableDefinitionDraft({
  slug,
  branchId,
  variable,
  canWrite,
  onSaved,
}: {
  slug: string
  branchId: string | null
  variable: Variable
  canWrite: boolean
  onSaved?: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(variable.name)
  const [type, setType] = useState<VariableType>(variable.variable_type)
  const [description, setDescription] = useState(variable.description)
  const [allowedValues, setAllowedValues] = useState<string[]>(variable.allowed_values ?? [])
  const [bindings, setBindings] = useState<string[]>(variable.bindings ?? [])
  // Inline, after Save was pressed, instead of `required` / `pattern` bubbles
  // (AU-4).
  const [submitted, setSubmitted] = useState(false)

  const valueRule = valueRuleFor(type)
  // Values already documented are not re-checked by the chip input when the
  // type changes, so the form names the ones the chosen type would refuse
  // (PLAN-24). Saving is held only when THIS edit changed the type: a legacy
  // variable whose values never matched can still have its description fixed.
  const invalidValues = invalidValuesFor(type, allowedValues)
  const typeChangeBlocked = invalidValues.length > 0 && type !== variable.variable_type

  // Legacy dotted names stay valid while unchanged; a NEW name must be dot-free
  // (bind data paths via bindings instead).
  const nameError = !name.trim()
    ? REQUIRED_MESSAGE
    : name === variable.name || isValidVariableName(name)
      ? null
      : VARIABLE_NAME_RULE_MESSAGE
  const shownNameError = submitted ? nameError : null

  const sameList = (a: readonly string[], b: readonly string[] | null | undefined) =>
    a.length === (b ?? []).length && a.every((value, index) => value === (b ?? [])[index])
  const dirty =
    name !== variable.name
    || type !== variable.variable_type
    || description !== variable.description
    || !sameList(allowedValues, variable.allowed_values)
    || !sameList(bindings, variable.bindings)

  const updateMut = useMutation({
    // Its error is rendered at the foot of the form.
    meta: SILENT_ERROR_META,
    mutationFn: () => variablesApi.update(slug, variable.id, {
      name,
      variable_type: type,
      description,
      allowed_values: allowedValues,
      bindings,
    }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      // A rename re-points every stored `${old}` to `${new}` on the backend
      // (variable_service), so the events table and event detail would keep
      // showing the old token until their cache aged out (PLAN-32).
      if (name !== variable.name) {
        qc.invalidateQueries({ queryKey: projectEventsKey(slug) })
        qc.invalidateQueries({ queryKey: projectEventKey(slug) })
      }
      onSaved?.()
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canWrite) return
    setSubmitted(true)
    if (nameError) {
      const form = event.currentTarget
      requestAnimationFrame(() => focusFirstInvalid(form))
      return
    }
    if (!typeChangeBlocked) updateMut.mutate()
  }

  return {
    name,
    setName,
    type,
    setType,
    description,
    setDescription,
    allowedValues,
    setAllowedValues,
    bindings,
    setBindings,
    valueRule,
    invalidValues,
    typeChangeBlocked,
    shownNameError,
    dirty,
    updateMut,
    handleSubmit,
  }
}

export type VariableDefinitionDraft = ReturnType<typeof useVariableDefinitionDraft>
