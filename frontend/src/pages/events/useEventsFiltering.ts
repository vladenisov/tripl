import { useCallback, useMemo } from 'react'

import type {
  EventListItem,
  EventType,
  EventTypeBrief,
  FieldDefinition,
  MetaFieldDefinition,
} from '@/types'

// Trim integer-valued floats ("5.0", "-3.00") down to their integer form
// for display and filtering.
function normalizeFieldValue(value: string): string {
  if (value && /^-?\d+\.0+$/.test(value)) return String(parseInt(value, 10))
  return value
}

/**
 * A row's value for a field column, resolved straight off the row.
 *
 * The table renders through a memoized per-row map (below); CSV export walks
 * rows that were never rendered and has no such map, so the lookup rules live
 * here in one place.
 */
export function resolveFieldValue(
  ev: EventListItem,
  col: FieldDefinition,
  fieldDefsById: Map<string, FieldDefinition>,
): string {
  for (const fv of ev.field_values) {
    if (fv.field_definition_id === col.id) return normalizeFieldValue(fv.value)
  }
  // Fallback for when the row's field_values reference a different
  // FieldDefinition row (e.g., another event-type with the same `name`).
  for (const fv of ev.field_values) {
    const def = fieldDefsById.get(fv.field_definition_id)
    if (def && def.name === col.name) return normalizeFieldValue(fv.value)
  }
  return ''
}

/** A row's value for a meta column, resolved straight off the row. */
export function resolveMetaValue(ev: EventListItem, mf: MetaFieldDefinition): string {
  for (const mv of ev.meta_values) {
    if (mv.meta_field_definition_id === mf.id) return mv.value
  }
  return ''
}

export type ColumnFilterContext = {
  fieldColumns: FieldDefinition[]
  metaFields: MetaFieldDefinition[]
  fieldFilters: Record<string, string>
  metaFilters: Record<string, string>
  getFieldValue: (ev: EventListItem, col: FieldDefinition) => string
  getMetaValue: (ev: EventListItem, mf: MetaFieldDefinition) => string
}

/**
 * Narrow rows by the per-column (field/meta) filters.
 *
 * Takes value accessors so the table can keep its memoized map lookups on the
 * hot render path while CSV export resolves values directly off freshly fetched
 * rows — one rule set, two callers. Returns the input array UNCHANGED when no
 * column filter is set: callers compare identity to tell whether the server
 * `total` still describes the list (useEventsTableVirtualization).
 */
export function filterEventsByColumns(
  rows: EventListItem[],
  ctx: ColumnFilterContext,
): EventListItem[] {
  const active =
    Object.values(ctx.fieldFilters).some(v => v !== '') ||
    Object.values(ctx.metaFilters).some(v => v !== '')
  if (!active) return rows
  return rows.filter(ev => eventMatchesColumnFilters(ev, ctx))
}

function eventMatchesColumnFilters(ev: EventListItem, ctx: ColumnFilterContext): boolean {
  for (const col of ctx.fieldColumns) {
    const wanted = ctx.fieldFilters[col.name]
    if (!wanted) continue
    const val = ctx.getFieldValue(ev, col)
    const exact = col.field_type === 'enum' || col.field_type === 'boolean'
    if (exact ? val !== wanted : !val.toLowerCase().includes(wanted.toLowerCase())) return false
  }
  for (const mf of ctx.metaFields) {
    const wanted = ctx.metaFilters[mf.name]
    if (!wanted) continue
    const val = ctx.getMetaValue(ev, mf)
    const exact = mf.field_type === 'enum' || mf.field_type === 'boolean'
    if (exact ? val !== wanted : !val.toLowerCase().includes(wanted.toLowerCase())) return false
  }
  return true
}

/**
 * Derived data the events table renders on top of `rawEvents`: per-event
 * field/meta value lookups, the column set, enum options, and the final
 * client-filtered list. Pulled out of EventsPage so the page file stops
 * doing O(N · F²) Object.fromEntries() work inline.
 */
export function useEventsFiltering({
  rawEvents,
  eventTypes,
  metaFields,
  activeEt,
  debouncedFieldFilters,
  debouncedMetaFilters,
}: {
  rawEvents: EventListItem[]
  eventTypes: EventType[]
  metaFields: MetaFieldDefinition[]
  activeEt: EventType | null
  debouncedFieldFilters: Record<string, string>
  debouncedMetaFilters: Record<string, string>
}) {
  const fieldColumns: FieldDefinition[] = useMemo(() => {
    if (activeEt) return [...activeEt.field_definitions].sort((a, b) => a.order - b.order)
    const seen = new Map<string, FieldDefinition>()
    for (const et of eventTypes) {
      for (const fd of [...et.field_definitions].sort((a, b) => a.order - b.order)) {
        if (!seen.has(fd.name)) seen.set(fd.name, fd)
      }
    }
    return Array.from(seen.values())
  }, [activeEt, eventTypes])

  const allFieldDefs = useMemo(() => {
    const map = new Map<string, FieldDefinition>()
    for (const et of eventTypes) {
      for (const fd of et.field_definitions) {
        map.set(fd.id, fd)
      }
    }
    return map
  }, [eventTypes])

  // Slim list responses ship event_type_id only; EventRow looks up the brief
  // here from the cached EventTypes (already loaded for filter tabs).
  const eventTypesById = useMemo(() => {
    const map = new Map<string, EventTypeBrief>()
    for (const et of eventTypes) {
      map.set(et.id, {
        id: et.id,
        name: et.name,
        display_name: et.display_name,
        color: et.color,
      })
    }
    return map
  }, [eventTypes])

  // Collect enum/boolean options per field column for filter dropdowns
  const fieldEnumOptions = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const col of fieldColumns) {
      if (col.field_type === 'enum' && col.enum_options) {
        map[col.id] = new Set(col.enum_options)
      } else if (col.field_type === 'boolean') {
        map[col.id] = new Set(['true', 'false'])
      }
    }
    return map
  }, [fieldColumns])

  // One Map<eventId, Map<fieldDefId, value>> built once per events list, instead
  // of re-building Object.fromEntries(...) inside every filter check and every
  // <TableCell> render (was O(N · F²) per render on the 2000-event path).
  const fieldValuesByEvent = useMemo(() => {
    const map = new Map<string, Map<string, string>>()
    for (const ev of rawEvents) {
      const fvMap = new Map<string, string>()
      for (const fv of ev.field_values) fvMap.set(fv.field_definition_id, fv.value)
      map.set(ev.id, fvMap)
    }
    return map
  }, [rawEvents])

  const metaValuesByEvent = useMemo(() => {
    const map = new Map<string, Map<string, string>>()
    for (const ev of rawEvents) {
      const mvMap = new Map<string, string>()
      for (const mv of ev.meta_values) mvMap.set(mv.meta_field_definition_id, mv.value)
      map.set(ev.id, mvMap)
    }
    return map
  }, [rawEvents])

  const getFieldValue = useCallback((ev: EventListItem, col: FieldDefinition) => {
    const direct = fieldValuesByEvent.get(ev.id)?.get(col.id)
    if (direct !== undefined) return normalizeFieldValue(direct)
    return resolveFieldValue(ev, col, allFieldDefs)
  }, [allFieldDefs, fieldValuesByEvent])

  const getMetaValue = useCallback(
    (ev: EventListItem, mf: MetaFieldDefinition) => metaValuesByEvent.get(ev.id)?.get(mf.id) ?? '',
    [metaValuesByEvent],
  )

  // Client-side filtering by field values and meta values
  const events = useMemo(() => {
    return filterEventsByColumns(rawEvents, {
      fieldColumns,
      metaFields,
      fieldFilters: debouncedFieldFilters,
      metaFilters: debouncedMetaFilters,
      getFieldValue,
      getMetaValue,
    })
  }, [
    rawEvents,
    debouncedFieldFilters,
    debouncedMetaFilters,
    fieldColumns,
    metaFields,
    getFieldValue,
    getMetaValue,
  ])

  return {
    fieldColumns,
    allFieldDefs,
    eventTypesById,
    fieldEnumOptions,
    fieldValuesByEvent,
    metaValuesByEvent,
    getFieldValue,
    getMetaValue,
    events,
  }
}
