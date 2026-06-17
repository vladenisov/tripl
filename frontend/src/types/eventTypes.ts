export interface EventType {
  id: string
  project_id: string
  name: string
  display_name: string
  description: string
  color: string
  order: number
  created_at: string
  updated_at: string
  field_definitions: FieldDefinition[]
}

export interface EventTypeBrief {
  id: string
  name: string
  display_name: string
  color: string
}

export interface FieldDefinition {
  id: string
  event_type_id: string
  name: string
  display_name: string
  field_type: 'string' | 'number' | 'boolean' | 'json' | 'enum' | 'url'
  is_required: boolean
  enum_options: string[] | null
  description: string
  order: number
  sensitivity: Sensitivity
  contract_required_max_null_rate?: number | null
  contract_regex?: string | null
  contract_min_value?: number | null
  contract_max_value?: number | null
  contract_max_bad_rate?: number
}

export type Sensitivity = 'none' | 'pii' | 'phi' | 'financial' | 'secret'

export const SENSITIVITY_OPTIONS: {
  value: Sensitivity
  label: string
}[] = [
  { value: 'none', label: 'None' },
  { value: 'pii', label: 'PII' },
  { value: 'phi', label: 'PHI' },
  { value: 'financial', label: 'Financial' },
  { value: 'secret', label: 'Secret' },
]

export type SensitivityStyle = { bg: string; fg: string }

/**
 * Canonical sensitivity chip colors — matches the design mockup `SENS_STYLE`
 * (`design/tripl/project/surface-pages.jsx`). Single source of truth for the
 * sensitivity pill rendered by `SensitivityChip`, shared by the events/types
 * surface tasks. `none` renders as an em-dash, so it has no entry here.
 */
export const SENSITIVITY_STYLE: Record<Exclude<Sensitivity, 'none'>, SensitivityStyle> = {
  pii: { bg: 'oklch(0.7 0.17 15 / 0.16)', fg: 'oklch(0.8 0.16 15)' },
  phi: { bg: 'oklch(0.7 0.16 300 / 0.16)', fg: 'oklch(0.8 0.15 300)' },
  financial: { bg: 'oklch(0.78 0.15 75 / 0.16)', fg: 'oklch(0.84 0.13 75)' },
  secret: { bg: 'oklch(0.42 0.02 250)', fg: 'oklch(0.92 0.01 250)' },
}

export interface EventTypeRelation {
  id: string
  project_id: string
  source_event_type_id: string
  target_event_type_id: string
  source_field_id: string
  target_field_id: string
  relation_type: string
  description: string
}

export interface MetaFieldDefinition {
  id: string
  project_id: string
  name: string
  display_name: string
  field_type: 'string' | 'url' | 'boolean' | 'enum' | 'date'
  is_required: boolean
  enum_options: string[] | null
  default_value: string | null
  link_template: string | null
  order: number
  sensitivity: Sensitivity
}
