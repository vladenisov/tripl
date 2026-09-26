import { fireEvent, render, screen, within } from '@testing-library/react'
import { Command } from 'cmdk'
import { describe, expect, it, vi } from 'vitest'
import type { SearchVariantGroup } from '@/types'
import { expectNoAxeViolations } from '@/test/axe'
import { SearchVariantCount, SearchVariantRows } from './search-variants'

const group: SearchVariantGroup = {
  key: 'type-1:event_name=Screen View | screen={screen}',
  pattern: 'event_name=Screen View | screen={screen}',
  placeholder: 'screen',
  count: 3,
  variants: [
    {
      id: 'doc-2',
      entity_id: 'event-2',
      event_id: 'event-2',
      title: 'event_name=Screen View | screen=Map',
      value: 'Map',
      route_path: '/p/demo/events/detail/event-2',
      score: 2,
      confidence: 0.5,
    },
    {
      id: 'doc-3',
      entity_id: 'event-3',
      event_id: 'event-3',
      title: 'event_name=Screen View | screen=Cart',
      value: 'Cart',
      route_path: '/p/demo/events/detail/event-3',
      score: 1,
      confidence: 0.4,
    },
  ],
}

function renderGroup(onSelectVariant = vi.fn()) {
  const result = render(
    <Command label="Palette" shouldFilter={false}>
      <Command.Input aria-label="Search" />
      <Command.List>
        <SearchVariantRows
          group={group}
          representative={
            <Command.Item value="search:doc-1">
              event_name=Screen View | screen=Home
              <SearchVariantCount count={group.variants.length} />
            </Command.Item>
          }
          toggleValue="variants:group"
          renderVariant={variant => (
            <Command.Item
              key={variant.id}
              value={`search:${variant.id}`}
              onSelect={() => onSelectVariant(variant.route_path)}
            >
              {variant.title}
            </Command.Item>
          )}
        />
      </Command.List>
    </Command>,
  )
  return { ...result, onSelectVariant }
}

describe('SearchVariantRows', () => {
  it('shows one row with a variant count and keeps members collapsed', () => {
    renderGroup()

    expect(
      screen.getByRole('option', { name: 'event_name=Screen View | screen=Home + 2 variants' }),
    ).toBeInTheDocument()
    const toggle = screen.getByRole('option', { name: /Show 2 variants/ })
    expect(toggle).toHaveAttribute('data-expanded', 'false')
    expect(screen.queryByText('event_name=Screen View | screen=Map')).not.toBeInTheDocument()
  })

  it('expands every member inline on click and collapses again', () => {
    renderGroup()

    const toggle = screen.getByRole('option', { name: /Show 2 variants/ })
    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('data-expanded', 'true')
    expect(toggle).toHaveAccessibleName(/Hide 2 variants/)
    const members = screen.getByRole('group', {
      name: 'Variants of event_name=Screen View | screen={screen}',
    })
    expect(toggle).toHaveAttribute('aria-controls', members.id)
    expect(within(members).getAllByRole('option').map(option => option.textContent)).toEqual([
      'event_name=Screen View | screen=Map',
      'event_name=Screen View | screen=Cart',
    ])

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('data-expanded', 'false')
    expect(screen.queryByText('event_name=Screen View | screen=Map')).not.toBeInTheDocument()
  })

  it('is operated from the keyboard: arrow to the toggle, Enter, then open a member', () => {
    const { onSelectVariant } = renderGroup()
    const input = screen.getByLabelText('Search')

    // cmdk selects the first row; one step down is the expand row.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /Show 2 variants/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('option', { name: /Hide 2 variants/ })).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelectVariant).toHaveBeenCalledWith('/p/demo/events/detail/event-2')
  })

  it('announces the expanded state on each toggle, and nothing before', () => {
    renderGroup()
    const status = screen.getByRole('status')
    expect(status).toBeEmptyDOMElement()

    fireEvent.click(screen.getByRole('option', { name: /Show 2 variants/ }))
    expect(status).toHaveTextContent(
      '2 variants of event_name=Screen View | screen={screen} expanded',
    )

    fireEvent.click(screen.getByRole('option', { name: /Hide 2 variants/ }))
    expect(status).toHaveTextContent(
      '2 variants of event_name=Screen View | screen={screen} collapsed',
    )
  })

  it('has no axe violations collapsed or expanded', async () => {
    const { container } = renderGroup()
    await expectNoAxeViolations(container)

    fireEvent.click(screen.getByRole('option', { name: /Show 2 variants/ }))
    await expectNoAxeViolations(container)
  })

  it('says "variant" for a group of two', () => {
    render(
      <p>
        Home
        <SearchVariantCount count={1} />
      </p>,
    )
    expect(screen.getByText(/Home/)).toHaveTextContent('Home + 1 variant')
  })
})
