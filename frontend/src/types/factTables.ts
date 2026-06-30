// Fact-table types, sourced directly from the committed backend OpenAPI
// (`api.gen.ts`) so the frontend stays in lock-step with the backend schemas.
// A fact table is a full read-only SELECT plus its introspected column metadata,
// reusable identifier columns, and named row filters; fact metrics aggregate one.
import type { components } from './api.gen'

type Schemas = components['schemas']

// ───────── Building blocks ─────────
export type FactTableColumn = Schemas['FactTableColumnSchema']
export type FactTableRowFilter = Schemas['FactTableRowFilter']

// ───────── Read shapes ─────────
export type FactTable = Schemas['FactTableResponse']
export type FactTableListItem = Schemas['FactTableListItem']
export type FactTableListResponse = Schemas['FactTableListResponse']

// ───────── Create / update payloads ─────────
export type FactTableCreate = Schemas['FactTableCreate']
export type FactTableUpdate = Schemas['FactTableUpdate']

// ───────── Preview (introspect a candidate SELECT) ─────────
export type FactTablePreviewRequest = Schemas['FactTablePreviewRequest']
export type FactTablePreviewResponse = Schemas['FactTablePreviewResponse']
