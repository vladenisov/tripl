import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EventsToolbar } from './EventsToolbar'

function renderToolbar(overrides: Partial<React.ComponentProps<typeof EventsToolbar>> = {}) {
  const onSortOrderChange = vi.fn()
  render(
    <EventsToolbar
      search=""
      onSearchChange={() => {}}
      isFilterPending={false}
      filterStatuses={[]}
      onFilterStatusesChange={() => {}}
      filterSilentDays={undefined}
      onFilterSilentDaysChange={() => {}}
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
      fieldColumns={[]}
      metaFields={[]}
      onToggleColumn={() => {}}
      onNewEvent={() => {}}
      {...overrides}
    />,
  )
  return { onSortOrderChange }
}

describe('EventsToolbar sort control', () => {
  it('renders the busiest-first sort control', () => {
    renderToolbar()

    expect(screen.getByRole('combobox', { name: 'Sort order' })).toBeInTheDocument()
    expect(screen.getByText('Sort')).toBeInTheDocument()
  })
})
