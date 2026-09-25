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
      filterOpenQuestions={undefined}
      onFilterOpenQuestionsChange={() => {}}
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
      canExport
      isExporting={false}
      onNewEvent={() => {}}
      onBulkNew={() => {}}
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

  it('asks the server which events are waiting on an answer', async () => {
    // Server-side like every other filter here: narrowing the loaded page would
    // answer for the page, not the catalog (tripl-h2sx.26).
    const onFilterOpenQuestionsChange = vi.fn()
    renderToolbar({ onFilterOpenQuestionsChange })

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Open questions filter' }), {
      key: 'Enter',
    })
    fireEvent.click(await screen.findByRole('option', { name: 'Open questions' }))

    expect(onFilterOpenQuestionsChange).toHaveBeenCalledWith(true)
  })

  it('withholds the export until the loaded view matches the current filters', async () => {
    // The export sweeps from the loaded page's `total`, so offering it against a
    // not-yet-loaded (or stale placeholder) page downloads a header-only file.
    const { onExportCsv } = renderToolbar({ canExport: false })

    fireEvent.keyDown(screen.getByRole('button', { name: 'More actions' }), { key: 'Enter' })

    const exportItem = await screen.findByRole('menuitem', { name: /Export CSV/ })
    expect(exportItem).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(exportItem)
    expect(onExportCsv).not.toHaveBeenCalled()
  })
})

describe('EventsToolbar search shortcut (EVT-34)', () => {
  it('focuses the search box on "/" pressed outside a text field', () => {
    renderToolbar()
    const search = screen.getByRole('textbox', { name: 'Filter events by name, tag, or field' })

    fireEvent.keyDown(document.body, { key: '/' })

    expect(search).toHaveFocus()
  })

  it('leaves "/" alone while another field is being typed in', () => {
    renderToolbar()
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()

    fireEvent.keyDown(other, { key: '/' })

    expect(other).toHaveFocus()
    other.remove()
  })
})

describe('EventsToolbar filters that came from a link (EVT-35)', () => {
  it('shows every status in the URL, not "Any status"', () => {
    renderToolbar({ filterStatuses: ['draft', 'live'] })

    const trigger = screen.getByRole('button', { name: 'Status filter' })
    expect(trigger).toHaveTextContent(/Draft, Live/)
    expect(trigger).not.toHaveTextContent(/any/)
  })

  it('shows a silent-days value no preset names', () => {
    renderToolbar({ filterSilentDays: 3 })

    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveTextContent(/Silent > 3d/)
  })
})

describe('EventsToolbar saved views (EVT-36)', () => {
  it('offers no saved views where the table is embedded in another page', () => {
    renderToolbar({ showSavedViews: false })

    expect(screen.queryByRole('button', { name: /Views/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Columns/ })).toBeInTheDocument()
  })
})

describe('EventsToolbar status multi-select (EVT-35)', () => {
  function openStatusMenu() {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Status filter' }), { key: 'Enter' })
  }

  it('reads "any" with nothing ticked, the default that hides archived', async () => {
    renderToolbar()

    expect(screen.getByRole('button', { name: 'Status filter' })).toHaveTextContent(/any/)
    openStatusMenu()
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Any status' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemcheckbox', { name: 'Archived' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('adds a second status to the ones already applied, in canonical order', async () => {
    const onFilterStatusesChange = vi.fn()
    renderToolbar({ filterStatuses: ['live'], onFilterStatusesChange })

    openStatusMenu()
    const draft = await screen.findByRole('menuitemcheckbox', { name: 'Draft' })
    expect(screen.getByRole('menuitemcheckbox', { name: 'Live' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(draft)

    expect(onFilterStatusesChange).toHaveBeenCalledWith(['draft', 'live'])
    // It stays open, so several statuses can be ticked in one visit.
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('unticks one status and leaves the rest', async () => {
    const onFilterStatusesChange = vi.fn()
    renderToolbar({ filterStatuses: ['draft', 'live'], onFilterStatusesChange })

    openStatusMenu()
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Draft' }))

    expect(onFilterStatusesChange).toHaveBeenCalledWith(['live'])
  })

  it('clears back to the default with "Any status"', async () => {
    const onFilterStatusesChange = vi.fn()
    renderToolbar({ filterStatuses: ['draft', 'live'], onFilterStatusesChange })

    openStatusMenu()
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Any status' }))

    expect(onFilterStatusesChange).toHaveBeenCalledWith([])
  })
})

describe('EventsToolbar status filter on a narrowing tab (EVT-35)', () => {
  it('names the archived tab default instead of reading "any"', async () => {
    renderToolbar({ filterStatuses: [], tabDefaultStatuses: ['archived'] })

    const trigger = screen.getByRole('button', { name: 'Status filter' })
    expect(trigger).toHaveTextContent(/Archived/)
    expect(trigger).not.toHaveTextContent(/any/)

    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Archived' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('menuitemcheckbox', { name: 'Tab default' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Any status' })).toBeNull()
  })

  it('adds to the tab default rather than replacing it', async () => {
    const onFilterStatusesChange = vi.fn()
    renderToolbar({ filterStatuses: [], tabDefaultStatuses: ['in_review'], onFilterStatusesChange })

    fireEvent.keyDown(screen.getByRole('button', { name: 'Status filter' }), { key: 'Enter' })
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Draft' }))

    expect(onFilterStatusesChange).toHaveBeenCalledWith(['draft', 'in_review'])
  })

  it('shows an explicit pick over the tab default', () => {
    renderToolbar({ filterStatuses: ['draft'], tabDefaultStatuses: ['archived'] })

    const trigger = screen.getByRole('button', { name: 'Status filter' })
    expect(trigger).toHaveTextContent(/Draft/)
    expect(trigger).not.toHaveTextContent(/Archived/)
  })
})
