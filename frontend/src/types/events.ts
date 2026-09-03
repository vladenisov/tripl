import type { components } from './api.gen'
import type { EventTypeBrief } from './eventTypes'

/** The backend's 7-value EventStatus, not a free-form string. */
export type EventStatus = components['schemas']['EventStatus']

export type VariableValueKind = 'low' | 'high'

export interface EventFieldVariableValue {
  id: string
  variable_id: string
  variable_name: string
  source_column: string
  value_kind: VariableValueKind
  observed_count: number
  values: string[]
  /** Optional to mirror the backend default: an older response omits it. */
  excluded_from_scans?: boolean
}

export interface EventFieldValue {
  id: string
  field_definition_id: string
  value: string
  variable_values?: EventFieldVariableValue[]
}

export interface EventMetaValue {
  id: string
  meta_field_definition_id: string
  value: string
}

export interface EventTag {
  id: string
  name: string
}

export interface Event {
  id: string
  project_id: string
  event_type_id: string
  event_type: EventTypeBrief
  name: string
  /**
   * The key a scan matches this event on — not `name`, which can be renamed
   * freely without the scan losing the event. Null until a scan sees it or a
   * naming rule governs its type.
   */
  source_name: string | null
  description: string
  order: number
  status: EventStatus
  sunset_at: string | null
  last_seen_at: string | null
  owner_id: string | null
  reviewed: boolean
  metric_breakdown_columns: string[]
  drift_count: number
  tags: EventTag[]
  field_values: EventFieldValue[]
  meta_values: EventMetaValue[]
  created_at: string
  updated_at: string
}

export interface EventMutationResponse extends Event {
  warnings: string[]
}

export interface EventChange {
  id: string
  event_id: string
  user_id: string | null
  user_email: string | null
  field: string
  old_value: string | null
  new_value: string | null
  created_at: string
}

export type SchemaDriftType =
  | 'new_field'
  | 'missing_field'
  | 'type_changed'
  | 'enum_violation'
  | 'required_null_violation'
  | 'regex_violation'
  | 'range_violation'

export interface SchemaDrift {
  id: string
  event_type_id: string
  scan_config_id: string | null
  field_name: string
  drift_type: SchemaDriftType
  observed_type: string | null
  declared_type: string | null
  sample_value: string | null
  status: 'open' | 'accepted' | 'snoozed' | 'false_positive'
  resolution_note: string | null
  snoozed_until: string | null
  resolved_at: string | null
  resolved_by: string | null
  detected_at: string
}

export interface SchemaDriftList {
  items: SchemaDrift[]
  total: number
}

// Slim shape returned by GET /events: drops nested event_type since the
// frontend already has EventTypes cached and looks them up by id, and adds
// `monitored` — alert-rule coverage the list endpoint computes per row (the
// detail response does not carry it).
export type EventListItem = Omit<Event, 'event_type'> & { monitored: boolean }

export interface EventListResponse {
  items: EventListItem[]
  total: number
}

export type EventPhotoKind = 'photo' | 'figma'

export interface EventPhoto {
  id: string
  event_id: string
  project_id: string
  kind: EventPhotoKind
  original_filename: string
  content_type: string
  size_bytes: number
  storage_backend: 'local' | 'gcs' | null
  sort_order: number
  url: string
  external_url: string | null
  uploaded_by_user_id: string | null
  created_at: string
}

export interface EventPhotoComment {
  id: string
  photo_id: string
  parent_id: string | null
  user_id: string | null
  body: string
  created_at: string
  updated_at: string
}

export type VariableType = 'string' | 'number' | 'boolean' | 'date' | 'datetime' | 'json' | 'string_array' | 'number_array'

export interface Variable {
  id: string
  project_id: string
  name: string
  source_name: string | null
  variable_type: VariableType
  description: string
  allowed_values: string[]
  bindings: string[]
  excluded_from_scans?: boolean
  open_drift_count?: number
  event_count?: number
  context_count?: number
  low_context_count?: number
  high_context_count?: number
  /** Observed values unioned across every context, de-duplicated and capped
   * server-side — enough for the list row's chips without a per-row request. */
  sample_values?: string[]
  /** Distinct event names this variable was observed in, alphabetical and
   * capped server-side; `event_count` carries the untruncated total. */
  event_names?: string[]
}

/** Envelope returned by `GET /projects/{slug}/variables` (offset/limit paged). */
export interface VariableListPage {
  items: Variable[]
  total: number
}

export interface VariableValueContext extends EventFieldVariableValue {
  event_id: string
  event_name: string
  field_definition_id: string
  field_name: string
  field_display_name: string
}
