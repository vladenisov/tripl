import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FilterBar, FilterSearch, FilterSelect } from './filter-bar'

const STATUS_OPTIONS = [
  { value: 'live', label: 'live' },
  { value: 'draft', label: 'draft' },
]

function renderBar({ status = 'any', onClear = vi.fn() } = {}) {
  render(
    <FilterBar count="42 events" active={status !== 'any'} onClear={onClear}>
      <FilterSearch things="events" value="" onValueChange={() => {}} />
      <FilterSelect label="Status" value={status} onValueChange={() => {}} options={STATUS_OPTIONS} />
    </FilterBar>,
  )
  return { onClear }
}

describe('FilterBar (DS-15)', () => {
  it('names the search box after its things and focuses it on "/"', () => {
    renderBar()
    const search = screen.getByRole('searchbox', { name: 'Search events' })
    expect(search).toHaveAttribute('placeholder', 'Search events…')

    fireEvent.keyDown(document.body, { key: '/' })
    expect(search).toHaveFocus()
  })

  it('shows an unset filter as a quiet "Label: any" chip and no clear link', () => {
    renderBar()
    const chip = screen.getByRole('combobox', { name: 'Status filter: any' })
    expect(chip).toHaveTextContent('Status:any')
    expect(chip).toHaveClass('border-dashed')
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
    expect(screen.getByText('42 events')).toBeInTheDocument()
  })

  it('marks a set filter and offers "Clear filters"', () => {
    const { onClear } = renderBar({ status: 'live' })
    const chip = screen.getByRole('combobox', { name: 'Status filter: live' })
    expect(chip).toHaveTextContent('Status:live')
    expect(chip).toHaveClass('bg-accent-soft')
    expect(chip).not.toHaveClass('border-dashed')

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('keeps the count live region mounted before there is a count', () => {
    const { rerender } = render(
      <FilterBar>
        <FilterSearch things="events" value="" onValueChange={() => {}} />
      </FilterBar>,
    )
    const region = document.querySelector('[data-slot="filter-bar"] [aria-live="polite"]')
    expect(region).toBeInTheDocument()
    expect(region).toBeEmptyDOMElement()

    rerender(
      <FilterBar count="3 events">
        <FilterSearch things="events" value="" onValueChange={() => {}} />
      </FilterBar>,
    )
    expect(document.querySelector('[data-slot="filter-bar"] [aria-live="polite"]')).toBe(region)
    expect(region).toHaveTextContent('3 events')
  })
})
