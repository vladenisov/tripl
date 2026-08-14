import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MAX_BULK_INBOX_ACTION_GROUPS } from '@/api/alerting'

import { InboxBulkActionBar, type InboxBulkActionRequest } from './InboxBulkActionBar'

/**
 * The four verbs the bar offers, matched by their leading word.
 *
 * Regexes rather than whole names because every control is announced with the
 * selection size in it ("Acknowledge 201 selected incidents"), and these tests
 * are about the cap, not about how a count is formatted.
 */
const ACTION_NAMES = [/^Acknowledge /, /^Resolve /, /^Mute /, /^Reopen /]

function renderBar(selectedCount: number) {
  const onAction = vi.fn<(request: InboxBulkActionRequest) => void>()
  const onClear = vi.fn()
  const utils = render(
    <InboxBulkActionBar
      selectedCount={selectedCount}
      isPending={false}
      onAction={onAction}
      onClear={onClear}
    />,
  )
  return { ...utils, onAction, onClear }
}

describe('InboxBulkActionBar — a selection the server would refuse (tripl-gpfr)', () => {
  it('acts normally at the cap itself, and says nothing about it', () => {
    // The boundary is inclusive on both sides of the wire: the server's
    // `max_length` admits exactly this many ids, so a bar that warned here would
    // block a batch the route would have accepted.
    renderBar(MAX_BULK_INBOX_ACTION_GROUPS)

    for (const name of ACTION_NAMES) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('stops the actions one incident over, and says exactly how many to untick', () => {
    // Reachable, not hypothetical: the inbox is an accumulating infinite list at
    // 50 rows per page, so "Load more" walks the selection past 200 and the only
    // feedback used to be a raw 422 about a list length — AFTER the operator had
    // committed to the decision.
    const { onAction } = renderBar(MAX_BULK_INBOX_ACTION_GROUPS + 1)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Over the 200-incident limit — untick 1 incident to act on the rest.',
    )
    for (const name of ACTION_NAMES) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }

    // Disabled means disabled: no request leaves, and the mute disclosure cannot
    // be opened to reach the duration buttons behind it either — those are
    // actions too, and "Until I unmute" is the furthest-reaching one there is.
    fireEvent.click(screen.getByRole('button', { name: /^Acknowledge / }))
    fireEvent.click(screen.getByRole('button', { name: /^Mute / }))
    expect(onAction).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /for 24h$/ })).toBeNull()
  })

  it('counts the surplus, not the selection', () => {
    // "Too many" leaves the reader counting ticks. The number they need is how
    // many rows to undo, and it is the only thing they can act on here.
    renderBar(MAX_BULK_INBOX_ACTION_GROUPS + 12)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Over the 200-incident limit — untick 12 incidents to act on the rest.',
    )
  })

  it('leaves the way out open', () => {
    // Clearing is one of the two routes back under the cap (unticking rows is
    // the other), so it is the one control that must survive the guard.
    const { onClear } = renderBar(MAX_BULK_INBOX_ACTION_GROUPS + 1)

    const clear = screen.getByRole('button', { name: 'Clear selection' })
    expect(clear).toBeEnabled()
    fireEvent.click(clear)
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
