import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PageHeader } from './page-header'

// DS-19 / LIVE-11: one header component instead of two "canonical" ones and a
// dozen hand-rolled h1s.
describe('PageHeader', () => {
  it('renders the title as the page heading with its count', () => {
    render(<PageHeader eyebrow="Observe" title="Events" count="17" />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Events 17')
    expect(screen.getByText('Observe')).toBeInTheDocument()
  })

  it('renders the back link, addon, description and actions', () => {
    render(
      <PageHeader
        back={<a href="/back">Back</a>}
        title="Metric"
        titleAddon={<span>Badge</span>}
        description="What this page is for."
        actions={<button type="button">Create</button>}
      />,
    )
    expect(screen.getByRole('link', { name: 'Back' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Metric' })).toBeInTheDocument()
    expect(screen.getByText('Badge')).toBeInTheDocument()
    expect(screen.getByText('What this page is for.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument()
  })

  it('leaves out the slots it was not given', () => {
    const { container } = render(<PageHeader title="Coverage" />)
    expect(screen.getByRole('heading', { level: 1, name: 'Coverage' })).toBeInTheDocument()
    expect(container.querySelector('p, button, a')).toBeNull()
  })
})
