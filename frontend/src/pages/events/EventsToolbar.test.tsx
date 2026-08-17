import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EventsToolbar } from './EventsToolbar'

function renderToolbar(overrides: Partial<React.ComponentProps<typeof EventsToolbar>> = {}) {
  const onSortOrderChange = vi.fn()
  const onExportCsv = vi.fn()
  render(
    <EventsToolbar
      search=""
      onSearchChange={() => {}}
      isFilterPending={false}
      filterStatuses={[]}
      onFilterStatusesChange={() => {}}
      filterSilentDays={undefined}
      onFilterSilentDaysChange={() => {}}
      filterReviewed={undefined}
      onFilterReviewedChange={() => {}}
      sortOrder="catalog"
      onSortOrderChange={onSortOrderChange}
      hasActiveFilters={false}
      onClearFilters={() => {}}
      savedViews={[]}
      activeSavedViewName={null}
      savedViewName=""
      onSavedViewNameChange={() => {}}
      onSaveCurrentView={() => {}}
      onApplySavedView={() => {}}
      onDeleteSavedView={() => {}}
      columnsMenuOpen={false}
      onColumnsMenuOpenChange={() => {}}
      hiddenColumns={new Set()}
      hideLastSeen={false}
      reviewedPinned={false}
      offscreenColumnCount={0}
      fieldColumns={[]}
      metaFields={[]}
      onToggleColumn={() => {}}
      onExportCsv={onExportCsv}
      isExporting={false}
      onNewEvent={() => {}}
      {...overrides}
    />,
  )
  return { onSortOrderChange, onExportCsv }
}

describe('EventsToolbar sort control', () => {
  it('renders the busiest-first sort control', () => {
    renderToolbar()

    expect(screen.getByRole('combobox', { name: 'Sort order' })).toBeInTheDocument()
    expect(screen.getByText('Sort')).toBeInTheDocument()
  })
})

describe('EventsToolbar reviewed filter (tripl-invv)', () => {
  it('offers a reviewed filter so the flag "Mark reviewed" writes can be isolated', () => {
    renderToolbar()

    expect(screen.getByRole('combobox', { name: 'Reviewed filter' })).toBeInTheDocument()
  })
})

describe('EventsToolbar More menu (tripl-evbw)', () => {
  it('offers a working export and no longer advertises the unbuilt Ask AI', async () => {
    const { onExportCsv } = renderToolbar()

    // Radix opens the menu from pointer/keyboard events jsdom does not
    // synthesise from a bare click — keyboard is the reliable path here.
    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' })

    const exportItem = await screen.findByRole('menuitem', { name: /Export CSV/ })
    expect(exportItem).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByText('Ask AI')).toBeNull()

    fireEvent.click(exportItem)
    expect(onExportCsv).toHaveBeenCalledTimes(1)
  })
})
