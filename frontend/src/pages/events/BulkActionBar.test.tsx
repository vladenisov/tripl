import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BulkActionBar } from './BulkActionBar'

function renderBar(overrides: Partial<Parameters<typeof BulkActionBar>[0]> = {}) {
  const props = {
    selectedCount: 5,
    isDeleting: false,
    isUpdating: false,
    onSetStatus: vi.fn(),
    onMarkReviewed: vi.fn(),
    onAssignOwner: vi.fn(),
    owners: [],
    onDelete: vi.fn(),
    onClear: vi.fn(),
    ...overrides,
  }
  render(<BulkActionBar {...props} />)
  return props
}

describe('BulkActionBar select-all-matching (tripl-7l83.11)', () => {
  it('offers to widen the selection when more events match than are selected', () => {
    const onSelectAllMatching = vi.fn()
    renderBar({ selectedCount: 5, matchingTotal: 499, onSelectAllMatching })

    const button = screen.getByRole('button', { name: 'Select all 499' })
    fireEvent.click(button)
    expect(onSelectAllMatching).toHaveBeenCalledTimes(1)
  })

  it('hides the affordance once the whole matching set is selected', () => {
    renderBar({ selectedCount: 499, matchingTotal: 499, onSelectAllMatching: vi.fn() })
    expect(screen.queryByRole('button', { name: /Select all/ })).toBeNull()
  })

  it('shows a pending label and disables actions while selecting all', () => {
    renderBar({
      selectedCount: 5,
      matchingTotal: 499,
      onSelectAllMatching: vi.fn(),
      isSelectingAll: true,
    })
    expect(screen.getByRole('button', { name: 'Selecting…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Mark reviewed/ })).toBeDisabled()
  })

  it('renders nothing when the selection is empty', () => {
    const { container } = render(
      <BulkActionBar
        selectedCount={0}
        isDeleting={false}
        isUpdating={false}
        onSetStatus={vi.fn()}
        onMarkReviewed={vi.fn()}
        onAssignOwner={vi.fn()}
        owners={[]}
        onDelete={vi.fn()}
        onClear={vi.fn()}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('BulkActionBar stale-selection disclosure (tripl-4i49)', () => {
  it('says how much of the selection is still on screen when they diverge', () => {
    renderBar({ selectedCount: 20, selectedVisibleCount: 3, matchingTotal: 3 })

    expect(screen.getByText('20')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/on screen/)).toBeInTheDocument()
  })

  it('stays a bare count while every selected row is on screen', () => {
    renderBar({ selectedCount: 2, selectedVisibleCount: 2, matchingTotal: 2 })

    expect(screen.queryByText(/on screen/)).toBeNull()
  })
})
