import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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

  it('prints the total once, with a thousands separator (EVT-16)', () => {
    render(
      <EventsHeader
        total={5000}
        inReviewCount={0}
        projectTotalSignal={null}
        eventTypeSignals={new Map()}
      />,
    )

    expect(screen.getAllByText((5000).toLocaleString())).toHaveLength(1)
    expect(screen.queryByText('5000')).not.toBeInTheDocument()
  })

  it('shows schema drift once per event type, named, not once per row (EVT-33)', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <EventsHeader
          total={300}
          inReviewCount={0}
          projectTotalSignal={null}
          eventTypeSignals={new Map()}
          slug="demo"
          typeDrifts={[
            { eventTypeId: 'et-pv', label: 'Page View', count: 3 },
            { eventTypeId: 'et-se', label: 'Structured', count: 1 },
          ]}
        />
      </QueryClientProvider>,
    )

    expect(
      screen.getByRole('button', { name: '3 schema drifts on event type Page View' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '1 schema drift on event type Structured' }),
    ).toBeInTheDocument()
  })
})
