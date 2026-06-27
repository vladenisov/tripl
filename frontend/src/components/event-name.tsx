import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { NAME_SEGMENT_SEPARATOR, splitEventName } from '@/pages/events/utils'

function EmptySegment(): ReactNode {
  return (
    <span title="empty segment" style={{ color: 'var(--fg-faint)' }}>
      ∅
    </span>
  )
}

/**
 * Renders a colon-namespaced event name, surfacing empty segments (e.g.
 * "spot::services") as an intentional muted ∅ placeholder rather than a silent
 * gap. Ordinary names render unchanged. Shared by the Events list and the
 * Reconciliation page so glitchy names read identically across surfaces.
 */
export function EventName({ name }: { name: string }): ReactNode {
  const segments = splitEventName(name)
  if (!segments) return name
  return segments.map((seg, i) => (
    <Fragment key={i}>
      {i > 0 && (
        <span aria-hidden style={{ color: 'var(--fg-faint)' }}>
          {NAME_SEGMENT_SEPARATOR}
        </span>
      )}
      {seg.empty ? <EmptySegment /> : <span>{seg.text}</span>}
    </Fragment>
  ))
}
