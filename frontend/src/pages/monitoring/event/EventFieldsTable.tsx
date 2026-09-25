import { Chip } from '@/components/primitives/chip'
import { SensitivityChip } from '@/components/primitives/sensitivity-chip'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { VariableValueContextTrigger } from '@/components/variable-value-contexts'
import type { Event as TEvent, EventType, FieldDefinition } from '@/types'
import { SURFACE_CARD, SURFACE_STYLE } from './surface'

const EV_TH_CLASS = 'h-auto px-[14px] py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--fg-subtle)]'
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
        // The field type is the least-read column; a phone keeps the name,
        // value and sensitivity.
        <Table aria-label="Fields">
          <TableHeader>
            <TableRow className="hover:bg-transparent" style={{ background: 'var(--bg-sunken)' }}>
              <TableHead scope="col" className={EV_TH_CLASS}>Field</TableHead>
              <TableHead scope="col" className={`${EV_TH_CLASS} hidden md:table-cell`}>Type</TableHead>
              <TableHead scope="col" className={EV_TH_CLASS}>Value</TableHead>
              {showSensitivity && <TableHead scope="col" className={EV_TH_CLASS}>Sensitivity</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map(field => {
              const fv = valueByField.get(field.id)
              const def = fieldDefMap.get(field.id) ?? field
              return (
                <TableRow key={field.id} style={{ borderColor: 'var(--border-subtle)' }}>
                  <TableCell className={EV_TD_CLASS}>
                    <span className="mono text-[12px]">{def.name}</span>
                    {def.is_required && <span className="ml-[3px]" style={{ color: 'var(--danger)' }}>*</span>}
                  </TableCell>
                  <TableCell className={`${EV_TD_CLASS} hidden md:table-cell`}>
                    <Chip size="xs" variant="outline">{def.field_type}</Chip>
                  </TableCell>
                  <TableCell className={EV_TD_CLASS}>
                    <span className="mono inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
                      <span className="break-all">{fv?.value || '—'}</span>
                      {fv?.variable_values?.length ? (
                        <VariableValueContextTrigger contexts={fv.variable_values} />
                      ) : null}
                    </span>
                  </TableCell>
                  {showSensitivity && (
                    <TableCell className={EV_TD_CLASS}><SensitivityChip value={def.sensitivity} /></TableCell>
                  )}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
