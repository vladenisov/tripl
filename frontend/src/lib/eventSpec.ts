import type { Event, EventFieldVariableValue, FieldDefinition } from '@/types'

const TOKEN = /\$\{([^}]+)\}/g

export interface SpecRow {
  field: FieldDefinition
  value: string
  namesTheEvent: boolean
  contexts: EventFieldVariableValue[]
}

/** The identity a scan matches on: `source_name` where the row has one, else the name. */
export function specIdentity(event: Pick<Event, 'name' | 'source_name'>): string {
  return event.source_name || event.name
}

/**
 * The example payload: field values with every `${variable}` token replaced by
 * the first documented value the event knows for it, or left as the token when
 * none is documented — a developer then sees exactly what is still open.
 */
export function buildExamplePayload(rows: SpecRow[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const row of rows) {
    if (!row.value) continue
    const filled = row.value.replace(TOKEN, (token, name: string) => {
      const context = row.contexts.find(c => c.variable_name === name)
      return context?.values[0] ?? token
    })
    if (row.field.field_type === 'json') {
      try {
        payload[row.field.name] = JSON.parse(filled)
        continue
      } catch {
        // Not valid JSON once filled (a template still in it): keep the text.
      }
    }
    payload[row.field.name] = filled
  }
  return payload
}

export function buildSpecMarkdown({
  identity,
  title,
  eventTypeName,
  description,
  rule,
  rows,
  payload,
}: {
  identity: string
  title: string
  eventTypeName: string | undefined
  description: string
  rule: string | null | undefined
  rows: SpecRow[]
  payload: Record<string, unknown>
}): string {
  const lines: string[] = [`## ${identity}`]
  if (title) lines.push('', title)
  if (eventTypeName) lines.push('', `Event type: ${eventTypeName}`)
  if (rule) lines.push(`Named by scan rule: \`${rule}\``)
  if (description) lines.push('', description)
  if (rows.length > 0) {
    lines.push('', '| Field | Type | Required | Value | Documented values |', '| --- | --- | --- | --- | --- |')
    for (const row of rows) {
      const documented = row.contexts
        .map(c => `${c.variable_name}: ${c.values.slice(0, 10).join(', ')}`)
        .join('; ')
      const required = row.field.is_required || row.namesTheEvent ? 'yes' : ''
      const marks = row.namesTheEvent ? ' (names the event)' : ''
      lines.push(
        `| \`${row.field.name}\`${marks} | ${row.field.field_type} | ${required} | ${row.value ? `\`${row.value}\`` : ''} | ${documented} |`,
      )
    }
  }
  lines.push('', '```json', JSON.stringify(payload, null, 2), '```', '')
  return lines.join('\n')
}

