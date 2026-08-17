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
})
