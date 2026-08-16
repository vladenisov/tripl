import type { EventFieldVariableValue } from './events'

/**
 * Kinds of entity the search index holds.
 *
 * This is a HAND-WRITTEN copy of the backend's `SearchEntityType` literal, kept
 * in step by hand — `api.gen.ts` carries the generated one, but the app imports
 * this. Adding a value on the backend without adding it here compiles fine and
 * simply loses the new kind at runtime — nothing on this side notices.
 *
 * There are THREE hand-written copies of the list, and only one of them is
 * guarded:
 *
 * - this file, unguarded;
 * - `ENTITY_META` in command-palette.tsx, which is a `Record<SearchEntityType, …>`
 *   and so fails the build for a value present HERE and missing there — it
 *   catches the second half of the edit, never the first;
 * - `tripl_cli.api.search.ENTITY_TYPES`, which `cli/tests/test_contract.py`
 *   compares against the OpenAPI enum. That is the only check that fails when
 *   the BACKEND gains a value and a copy does not.
 *
 * So a backend addition is caught by the CLI's contract test, in CI, and not by
 * anything in this package. Extend all three.
 */
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
  | 'scan_config'
  | 'alert_rule'

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
