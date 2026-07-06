import type { EventFieldVariableValue } from './events'

export type SearchEntityType =
  | 'event'
  | 'event_type'
  | 'field'
  | 'meta_field'
  | 'variable'
  | 'relation'
  | 'tag'
  | 'metric'
  | 'fact_table'

export interface SearchEventVariableValue extends EventFieldVariableValue {
  field_definition_id: string
  field_name: string
  field_display_name: string
}

export interface SearchResult {
  id: string
  entity_type: SearchEntityType
  entity_id: string
  parent_event_id: string | null
  event_id: string | null
  name: string | null
  /** Legacy field from search index — may be null for non-event results */
  implemented: boolean | null
  variable_values: SearchEventVariableValue[]
  title: string
  subtitle: string
  description: string
  snippet: string
  route_path: string
  score: number
  /** Relevance normalized to the top result of the response, in [0, 1]. */
  confidence: number
  highlights: string[]
  semantic_used: boolean
}

export interface SearchResponse {
  items: SearchResult[]
  total: number
  semantic_used: boolean
}
