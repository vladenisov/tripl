/**
 * The pulsing ring a coach mark draws around its anchor (tripl-odrj.2).
 *
 * An overlay, not a wrapper: the ring is a fixed-position div portalled to
 * document.body and sized from the anchor's client rect, so anchors whose DOM
 * position is load-bearing — the <tr> in ScanDetail — keep valid markup and
 * nothing in the page shifts. `pointer-events: none` (in .coach-ring) keeps the
 * exact control clickable through the ring.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/** The ring sits this far outside the anchor on every edge. */
const RING_PAD = 2

/** Below the popover card (z-50) so the card is never occluded by its own ring. */
const RING_Z_INDEX = 49

interface AnchorRect {
  top: number
  left: number
  width: number
  height: number
}

function readRect(anchor: HTMLElement): AnchorRect {
  const rect = anchor.getBoundingClientRect()
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

function sameRect(a: AnchorRect, b: AnchorRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
}

export function CoachBeacon({ anchor }: { anchor: HTMLElement }) {
  const [rect, setRect] = useState<AnchorRect>(() => readRect(anchor))

  useEffect(() => {
    const refresh = () => {
      setRect((prev) => {
        const next = readRect(anchor)
        return sameRect(prev, next) ? prev : next
      })
    }
    refresh()
    const observer = new ResizeObserver(refresh)
    observer.observe(anchor)
    // The body too: layout shifts that MOVE the anchor without resizing it
    // (a diff row collapsing above it, form hints appearing) change the body's
    // height, so this catches them without any polling loop.
    observer.observe(document.body)
    window.addEventListener('resize', refresh)
    // Capture: the anchor may live inside any scroll container, not just the page.
    window.addEventListener('scroll', refresh, { capture: true, passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', refresh)
      window.removeEventListener('scroll', refresh, { capture: true })
    }
  }, [anchor])

  // A 0x0 rect means the anchor is not laid out (hidden tab, display:none) —
  // a ring there would point at the page corner.
  if (rect.width === 0 && rect.height === 0) return null

  return createPortal(
    <div
      aria-hidden
      className="coach-ring"
      style={{
        position: 'fixed',
        top: rect.top - RING_PAD,
        left: rect.left - RING_PAD,
        width: rect.width + RING_PAD * 2,
        height: rect.height + RING_PAD * 2,
        zIndex: RING_Z_INDEX,
      }}
    />,
    document.body,
  )
}
