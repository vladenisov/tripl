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
