import type { Event } from '@/types'

export type SuccessorCandidate = Pick<Event, 'id' | 'name'> & Partial<Pick<Event, 'event_type_id' | 'status' | 'created_at'>>

/** Labels that repeat within `items` gain a detail, one step at a time, until
 * each option reads differently. */
export function disambiguate(
  items: readonly SuccessorCandidate[],
  base: (item: SuccessorCandidate) => string,
): { id: string; name: string }[] {
  const repeated = (labels: string[]) => {
    const counts = new Map<string, number>()
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
    return (label: string) => (counts.get(label) ?? 0) > 1
  }
  const bases = items.map(base)
  const baseRepeats = repeated(bases)
  const detailed = items.map((item, i) => {
    const label = bases[i] ?? ''
    if (!baseRepeats(label)) return label
    const added = item.created_at ? `added ${item.created_at.slice(0, 10)}` : undefined
    return [label, item.status, added].filter(Boolean).join(' · ')
  })
  const detailRepeats = repeated(detailed)
  return items.map((item, i) => {
    const label = detailed[i] ?? ''
    return { id: item.id, name: detailRepeats(label) ? `${label} · #${item.id.slice(0, 8)}` : label }
  })
}
