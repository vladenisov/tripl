import { useCallback, useMemo } from 'react'

import type {
  EventListItem,
  EventType,
  EventTypeBrief,
  FieldDefinition,
  MetaFieldDefinition,
} from '@/types'

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
    const fvMap = fieldValuesByEvent.get(ev.id)
    if (fvMap) {
      const direct = fvMap.get(col.id)
      if (direct !== undefined) return direct
    }
    // Fallback for when the row's field_values reference a different
    // FieldDefinition row (e.g., another event-type with the same `name`).
    for (const fv of ev.field_values) {
      const def = allFieldDefs.get(fv.field_definition_id)
      if (def && def.name === col.name) return fv.value
    }
    return ''
  }, [allFieldDefs, fieldValuesByEvent])

  // Client-side filtering by field values and meta values
  const events = useMemo(() => {
    const hasFieldFilter = Object.values(debouncedFieldFilters).some(v => v !== '')
    const hasMetaFilter = Object.values(debouncedMetaFilters).some(v => v !== '')
    if (!hasFieldFilter && !hasMetaFilter) return rawEvents

    return rawEvents.filter(ev => {
      for (const col of fieldColumns) {
        const fv = debouncedFieldFilters[col.name]
        if (!fv) continue
        const val = getFieldValue(ev, col)
        if (col.field_type === 'enum' || col.field_type === 'boolean') {
          if (val !== fv) return false
        } else {
          if (!val.toLowerCase().includes(fv.toLowerCase())) return false
        }
      }
      const mvMap = metaValuesByEvent.get(ev.id)
      for (const mf of metaFields) {
        const mv = debouncedMetaFilters[mf.name]
        if (!mv) continue
        const val = mvMap?.get(mf.id) ?? ''
        if (mf.field_type === 'enum' || mf.field_type === 'boolean') {
          if (val !== mv) return false
        } else {
          if (!val.toLowerCase().includes(mv.toLowerCase())) return false
        }
      }
      return true
    })
  }, [rawEvents, debouncedFieldFilters, debouncedMetaFilters, fieldColumns, metaFields, getFieldValue, metaValuesByEvent])

  return {
    fieldColumns,
    allFieldDefs,
    eventTypesById,
    fieldEnumOptions,
    fieldValuesByEvent,
    metaValuesByEvent,
    getFieldValue,
    events,
  }
}
