import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EventType } from '@/types'
import { EventsHeader } from './EventsHeader'

const PAGE_VIEW = {
  id: 'et-pv',
  name: 'pv',
  display_name: 'Page View',
} as unknown as EventType

describe('EventsHeader', () => {
  it('shows the generic "Events" heading when no type tab is active', () => {
    render(
      <EventsHeader
        total={12}
        inReviewCount={0}
        projectTotalSignal={null}
        eventTypeSignals={new Map()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Events' })).toBeInTheDocument()
  })

  it('reflects the active type in the heading on a type-scoped list', () => {
    render(
      <EventsHeader
        total={12}
        inReviewCount={0}
        projectTotalSignal={null}
        eventTypeSignals={new Map()}
        activeType={PAGE_VIEW}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Page View events' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Events' })).not.toBeInTheDocument()
  })

  it('says the in-review stat is project-wide, not a slice of Total (tripl-4oqs)', () => {
    // The archived tab rendered "TOTAL 1 · IN REVIEW 6 pending" above a single
    // archived row. Lifecycle status is single-valued, so 6 of those 1 events
    // cannot be awaiting review — the row only reads as one sentence because
    // nothing marked the wider scope.
    render(
      <EventsHeader
        total={1}
        inReviewCount={6}
        projectTotalSignal={null}
        eventTypeSignals={new Map()}
      />,
    )

    const inReviewStat = screen.getByText('6').closest('dl')
    expect(inReviewStat).toHaveTextContent(/project/i)
    expect(
      screen.getByRole('button', { name: /ignores the tab, filters and search/i }),
    ).toBeInTheDocument()
  })
})
