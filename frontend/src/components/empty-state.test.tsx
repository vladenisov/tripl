import { render, screen } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { EmptyState } from './empty-state'

describe('EmptyState', () => {
  it('titles itself at h2 so the page outline never jumps h1 → h3', () => {
    render(<EmptyState icon={Inbox} title="No monitors yet" description="Nothing to see." />)

    // Pages render an h1 and then drop straight into an empty state, so an h3
    // here left a hole in the heading outline (tripl-jfm3.69).
    expect(screen.getByRole('heading', { name: 'No monitors yet', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
  })
})

describe('EmptyState options (DS-16, DS-38)', () => {
  it('takes a lower heading level inside a card that already has one', () => {
    render(<EmptyState title="No scans yet" size="sm" headingLevel={3} />)

    expect(screen.getByRole('heading', { name: 'No scans yet', level: 3 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })

  it('renders without an icon and keeps the description and action', () => {
    render(
      <EmptyState
        title="No users yet"
        size="sm"
        description="Invite someone to get started."
        action={<button type="button">Invite</button>}
      />,
    )

    expect(screen.getByText('Invite someone to get started.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument()
  })
})
