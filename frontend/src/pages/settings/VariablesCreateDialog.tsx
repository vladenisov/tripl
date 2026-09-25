import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { variablesApi } from '@/api/variables'
import type { VariableType } from '@/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ChipListInput } from '@/components/chip-list-input'
import { Select } from '@/components/settings/kit'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { variablesKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'
import type { BindingExample } from './bindingExample'
import { BindingVersusTokenNote } from './VariablesBindingNote'
import { INVALID_BINDING_MESSAGE, isValidBinding, VARIABLE_TYPE_OPTIONS } from './variablesShared'
import { invalidValuesFor, valueRuleFor } from './variableValueValidation'

/**
 * The New Variable dialog. It owns its form state, so typing in it re-renders
 * the dialog and not the whole variables page behind it (PLAN-31). Mounted only
 * while open, which also resets the form each time it opens.
 */
export function VariablesCreateDialog({
  slug,
  branchId,
  example,
  onClose,
}: {
  slug: string
  branchId: string | null
  example: BindingExample
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [varType, setVarType] = useState<VariableType>('string')
  const [description, setDescription] = useState('')
  const [allowedValues, setAllowedValues] = useState<string[]>([])
  const [bindings, setBindings] = useState<string[]>([])
  const nameId = useId()
  const typeId = useId()
  const descriptionId = useId()
  const valuesId = useId()
  const bindingsId = useId()

  const valueRule = valueRuleFor(varType)
  // Values typed before the type changed are not re-checked by the chip input,
  // so the form says which of them the new type would refuse (PLAN-24).
  const invalidValues = invalidValuesFor(varType, allowedValues)

  const createMut = useMutation({
    // Its error is rendered in the dialog.
    meta: SILENT_ERROR_META,
    mutationFn: () =>
      variablesApi.create(
        slug,
        { name, variable_type: varType, description, allowed_values: allowedValues, bindings },
        branchId,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      onClose()
    },
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (invalidValues.length === 0) createMut.mutate()
          }}
        >
          <DialogHeader><DialogTitle>New Variable</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor={nameId}>Name (lowercase, e.g. spot_id)</Label>
              <Input id={nameId} value={name} onChange={e => setName(e.target.value)} required placeholder="my_variable" pattern="^[a-z][a-z0-9_]*$" />
            </div>
            {/* One column on phones: two side by side left each ~150px in a
                343px dialog (PLAN-53). */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor={typeId}>Type</Label>
                <Select
                  id={typeId}
                  value={varType}
                  onChange={value => setVarType(value as VariableType)}
                  options={VARIABLE_TYPE_OPTIONS}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={descriptionId}>Description</Label>
                <Input id={descriptionId} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={valuesId}>Possible values (optional)</Label>
              <ChipListInput
                inputId={valuesId}
                values={allowedValues}
                onChange={setAllowedValues}
                placeholder="Type a value, press Enter"
                ariaLabel="Add possible value"
                {...valueRule}
              />
              {invalidValues.length > 0 && (
                <p role="alert" className="text-xs text-destructive">
                  Not valid for this type: {invalidValues.join(', ')}. Remove them or pick another type.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              {/* Three of the four fields here are optional and only Description
                  said so, which read as "the other two are not". Bindings least
                  of all: a scan matches a variable by NAME first, so a variable
                  named after its column needs none. */}
              <Label htmlFor={bindingsId}>Data bindings (optional)</Label>
              <ChipListInput inputId={bindingsId} values={bindings} onChange={setBindings} placeholder={`e.g. ${example.binding}`} ariaLabel="Add data binding" validate={isValidBinding} invalidMessage={INVALID_BINDING_MESSAGE} />
              <p className="text-[11px] text-muted-foreground">Leave it empty and scans match this variable by its name. Add a binding only when the warehouse column or JSON path is spelled differently.</p>
              <BindingVersusTokenNote example={example} />
            </div>
            {createMut.isError && <p className="text-sm text-destructive">{getErrorMessage(createMut.error)}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMut.isPending || invalidValues.length > 0}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
