import type { VariableType } from '@/types'

// Warehouse column or dotted JSON path, e.g. "variant" or "page_data.extra.variant".
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/
export const isValidBinding = (value: string) => BINDING_PATTERN.test(value)
export const INVALID_BINDING_MESSAGE =
  'Invalid path — use letters/digits/underscores with dots, e.g. page_data.extra.variant'

export const VARIABLE_TYPES: VariableType[] = ['string', 'number', 'boolean', 'date', 'datetime', 'json', 'string_array', 'number_array']
export const TYPE_LABELS: Record<VariableType, string> = {
  string: 'String', number: 'Number', boolean: 'Boolean', date: 'Date',
  datetime: 'Datetime', json: 'JSON', string_array: 'String[]', number_array: 'Number[]',
}
/** The type choices in the settings kit's Select shape. */
export const VARIABLE_TYPE_OPTIONS = VARIABLE_TYPES.map(type => ({ value: type, label: TYPE_LABELS[type] }))
