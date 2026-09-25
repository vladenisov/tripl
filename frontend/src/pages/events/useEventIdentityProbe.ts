import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { eventsApi } from '@/api/events'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { eventIdentityProbeKey } from '@/lib/queryKeys'

/** An event already holding the identity the form is about to claim. */
export interface IdentityHolder {
  id: string
  name: string
}

/** An event this form created, with the type it was created under: identities
 *  are unique per event type (`_event_holding_scan_identity` keys on both), so
 *  a name taken under one type is still free under another. */
export interface CreatedIdentity extends IdentityHolder {
  eventTypeId: string
}

/**
 * Advisory duplicate check. The SERVER is what refuses a taken scan identity
 * (409 from create_event); this only spares the user filling a whole form to
 * find out on submit. `search` is a plain ILIKE over name/description/
 * source_name, so an exact name is always inside the result set and the exact
 * comparison below cannot produce a false POSITIVE. A false negative is
 * possible if a very broad match pushes the row past the limit — and the
 * server still catches that one.
 *
 * `createdHere` is what this form has itself created. "Save and add another"
 * keeps the values, so they regenerate the name just taken, and the probe's
 * cached "not taken" answer outlived the save — Save stayed enabled and the
 * second press met the server's 409 instead of this warning (EVT-25). The form
 * also invalidates the probes on a create; this closes the window until the
 * refetch lands.
 */
export function useEventIdentityProbe({
  slug,
  branchId,
  eventTypeId,
  completedName,
  enabled,
  createdHere,
}: {
  slug: string
  branchId: string | null
  eventTypeId: string
  /** The composed name, or null while fields it is built from are missing. */
  completedName: string | null
  enabled: boolean
  createdHere: readonly CreatedIdentity[]
}): IdentityHolder | null {
  const probedName = useDebouncedValue(completedName, 350)
  const { data: identityProbe } = useQuery({
    queryKey: eventIdentityProbeKey(slug, branchId, eventTypeId, probedName),
    queryFn: () =>
      eventsApi.list(slug, { event_type_id: eventTypeId, search: probedName!, limit: 100 }, branchId),
    enabled: enabled && !!probedName && !!eventTypeId,
  })
  return useMemo(() => {
    if (!enabled || !completedName) return null
    const mine = createdHere.find(
      item => item.name === completedName && item.eventTypeId === eventTypeId,
    )
    if (mine) return mine
    if (probedName !== completedName || !identityProbe) return null
    // The same two arms the server tests in `_event_holding_scan_identity`: an
    // event answering to this identity, or one with no identity yet whose name
    // the next scan will adopt as one. Matching on `name` alone would miss a
    // scanned event that has since been renamed — exactly the case source_name
    // exists for.
    return (
      identityProbe.items.find(
        item =>
          item.source_name === probedName
          || (item.source_name === null && item.name === probedName),
      ) ?? null
    )
  }, [enabled, completedName, createdHere, eventTypeId, probedName, identityProbe])
}
