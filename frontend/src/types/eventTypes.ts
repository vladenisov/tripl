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
  chip: string
}[] = [
  { value: 'none', label: 'None', chip: 'bg-muted text-muted-foreground' },
  { value: 'pii', label: 'PII', chip: 'bg-rose-500/15 text-rose-700' },
  { value: 'phi', label: 'PHI', chip: 'bg-purple-500/15 text-purple-700' },
  { value: 'financial', label: 'Financial', chip: 'bg-amber-500/15 text-amber-700' },
  { value: 'secret', label: 'Secret', chip: 'bg-slate-800/80 text-slate-100' },
]

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
