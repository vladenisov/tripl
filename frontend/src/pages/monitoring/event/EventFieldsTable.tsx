import { Chip } from '@/components/primitives/chip'
import { SensitivityChip } from '@/components/primitives/sensitivity-chip'
import { VariableValueContextTrigger } from '@/components/variable-value-contexts'
import type { Event as TEvent, EventType, FieldDefinition } from '@/types'
import { SURFACE_CARD, SURFACE_STYLE } from './surface'

const EV_TH_CLASS = 'px-[14px] py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--fg-subtle)]'
const EV_TD_CLASS = 'px-[14px] py-[9px] text-[12.5px] align-middle'

export function EventFieldsTable({
  eventType,
  event,
  fieldDefMap,
}: {
  eventType: EventType | undefined
  event: TEvent
  fieldDefMap: Map<string, FieldDefinition>
}) {
  const fields = [...(eventType?.field_definitions ?? [])].sort((a, b) => a.order - b.order)
  const valueByField = new Map(event.field_values.map(fv => [fv.field_definition_id, fv]))
  const requiredCount = fields.filter(f => f.is_required).length
  // Hide the Sensitivity column when no field carries a sensitivity label —
  // otherwise it renders a "—" for every row, adding noise without signal.
  const showSensitivity = fields.some(f => (fieldDefMap.get(f.id) ?? f).sensitivity !== 'none')
  return (
    <div className={SURFACE_CARD} style={SURFACE_STYLE}>
      <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <span className="flex-1 text-[12.5px] font-semibold">Fields</span>
        <span className="mono text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
          {fields.length} · {requiredCount} required
        </span>
      </div>
      {fields.length === 0 ? (
        <div className="px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          No fields defined.
        </div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full border-collapse" aria-label="Fields">
          <thead>
            <tr style={{ background: 'var(--bg-sunken)' }}>
              <th scope="col" className={EV_TH_CLASS}>Field</th>
              <th scope="col" className={EV_TH_CLASS}>Type</th>
              <th scope="col" className={EV_TH_CLASS}>Value</th>
              {showSensitivity && <th scope="col" className={EV_TH_CLASS}>Sensitivity</th>}
            </tr>
          </thead>
          <tbody>
            {fields.map(field => {
              const fv = valueByField.get(field.id)
              const def = fieldDefMap.get(field.id) ?? field
              return (
                <tr key={field.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className={EV_TD_CLASS}>
                    <span className="mono text-[12px]">{def.name}</span>
                    {def.is_required && <span className="ml-[3px]" style={{ color: 'var(--danger)' }}>*</span>}
                  </td>
                  <td className={EV_TD_CLASS}><Chip size="xs" variant="outline">{def.field_type}</Chip></td>
                  <td className={EV_TD_CLASS}>
                    <span className="mono inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
                      <span className="break-all">{fv?.value || '—'}</span>
                      {fv?.variable_values?.length ? (
                        <VariableValueContextTrigger contexts={fv.variable_values} />
                      ) : null}
                    </span>
                  </td>
                  {showSensitivity && (
                    <td className={EV_TD_CLASS}><SensitivityChip value={def.sensitivity} /></td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}
