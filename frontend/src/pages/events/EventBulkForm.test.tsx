import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventType } from '@/types'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import EventBulkForm from './EventBulkForm'

vi.mock('@/api/events', () => ({
  eventsApi: {
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    bulkCreate: vi.fn().mockResolvedValue([]),
  },
}))
vi.mock('@/api/eventTypes', () => ({ eventTypesApi: { list: vi.fn() } }))

// The rule arrives ON the type, resolved by the server — not read off the scan
// list by event_type_id, which a branch copy of the type never matches
// (tripl-kjhi.1).
const SE_TYPE = {
  id: 'et-se',
  name: 'se',
  display_name: 'Structured Event',
  event_name_format: '{category}:{action}:{label}',
  field_definitions: [
    { id: 'f-category', name: 'category', display_name: 'Category', field_type: 'string', is_required: false, order: 0 },
    { id: 'f-action', name: 'action', display_name: 'Action', field_type: 'string', is_required: false, order: 1 },
    { id: 'f-label', name: 'label', display_name: 'Label', field_type: 'string', is_required: false, order: 2 },
  ],
} as unknown as EventType

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      MemoryRouter,
      { initialEntries: ['/p/demo/events/all/bulk'] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/p/:slug/events/:tab/bulk', element: children }),
      ),
    ),
  )
}

async function chooseType(id = 'et-se') {
  // Wait for the OPTION, not just the select: a controlled <select> ignores a
  // value it has no option for, so firing the change before the types resolve
  // silently leaves the form on "Select type…".
  await screen.findByRole('option', { name: 'Structured Event' })
  fireEvent.change(screen.getByLabelText(/Event type/), { target: { value: id } })
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(eventTypesApi.list).mockResolvedValue([SE_TYPE])
  vi.mocked(eventsApi.list).mockResolvedValue({ items: [], total: 0 } as never)
  vi.mocked(eventsApi.bulkCreate).mockResolvedValue([] as never)
})

describe('EventBulkForm', () => {
  it('previews the name the scan rule will give each line', async () => {
    render(createElement(EventBulkForm), { wrapper })
    await chooseType()

    fireEvent.change(await screen.findByLabelText('Events to create'), {
      target: { value: 'settings\tunit_change\twind_speed\nspot\topen\tmodels' },
    })

    expect(await screen.findByText('settings:unit_change:wind_speed')).toBeInTheDocument()
    expect(screen.getByText('spot:open:models')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create 2 events' })).not.toBeDisabled()
  })

  it('sends the field values the name was built from, not just the name', async () => {
    render(createElement(EventBulkForm), { wrapper })
    await chooseType()
    fireEvent.change(await screen.findByLabelText('Events to create'), {
      target: { value: 'settings\tunit_change\twind_speed' },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Create 1 event' }))

    // An event carrying the name and none of the values behind it would show an
    // empty Field values card and drift from its scanned counterpart.
    await waitFor(() =>
      expect(eventsApi.bulkCreate).toHaveBeenCalledWith(
        'demo',
        [
          {
            event_type_id: 'et-se',
            name: 'settings:unit_change:wind_speed',
            status: 'draft',
            field_values: [
              { field_definition_id: 'f-category', value: 'settings' },
              { field_definition_id: 'f-action', value: 'unit_change' },
              { field_definition_id: 'f-label', value: 'wind_speed' },
            ],
          },
        ],
        null,
      ),
    )
  })

  it('carries a title given after the identity columns, and previews it', async () => {
    render(createElement(EventBulkForm), { wrapper })
    await chooseType()
    fireEvent.change(await screen.findByLabelText('Events to create'), {
      target: { value: 'weather_alert,show,widget,Weather alert widget shown' },
    })

    // The label is visible before it is stored, next to the identity it never
    // becomes part of (tripl-kjhi.3).
    expect(await screen.findByText('weather_alert:show:widget')).toBeInTheDocument()
    expect(screen.getByText('Weather alert widget shown')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create 1 event' }))

    await waitFor(() =>
      expect(eventsApi.bulkCreate).toHaveBeenCalledWith(
        'demo',
        [
          expect.objectContaining({
            name: 'weather_alert:show:widget',
            title: 'Weather alert widget shown',
            field_values: [
              { field_definition_id: 'f-category', value: 'weather_alert' },
              { field_definition_id: 'f-action', value: 'show' },
              { field_definition_id: 'f-label', value: 'widget' },
            ],
          }),
        ],
        null,
      ),
    )
  })

  it('takes free names from a type no rule governs', async () => {
    vi.mocked(eventTypesApi.list).mockResolvedValue([
      { ...SE_TYPE, event_name_format: null, field_definitions: [] } as unknown as EventType,
    ])
    render(createElement(EventBulkForm), { wrapper })
    await chooseType()
    fireEvent.change(await screen.findByLabelText('Events to create'), {
      target: { value: 'checkout:started\tCheckout started\ncheckout:completed' },
    })

    expect(await screen.findByText('checkout:started')).toBeInTheDocument()
    expect(screen.getByText('Checkout started')).toBeInTheDocument()
    expect(screen.getByText('checkout:completed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create 2 events' })).not.toBeDisabled()
  })

  it('leaves out the lines it cannot create, and says why', async () => {
    vi.mocked(eventsApi.list).mockResolvedValue({
      items: [{ id: 'ev-1', name: 'spot:open:models', source_name: 'spot:open:models' }],
      total: 1,
    } as never)
    render(createElement(EventBulkForm), { wrapper })
    await chooseType()

    fireEvent.change(await screen.findByLabelText('Events to create'), {
      target: {
        value: [
          'settings\tunit_change\twind_speed',
          'settings\tunit_change\twind_speed',
          'spot\topen\tmodels',
          'settings\tunit_change',
        ].join('\n'),
      },
    })

    expect(await screen.findByText('repeated above')).toBeInTheDocument()
    expect(screen.getByText('already in the catalog')).toBeInTheDocument()
    expect(screen.getByText('missing label')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create 1 event' })).toBeInTheDocument()
  })

  it('refuses a type whose required fields a pasted list cannot fill', async () => {
    vi.mocked(eventTypesApi.list).mockResolvedValue([
      {
        ...SE_TYPE,
        field_definitions: [
          ...SE_TYPE.field_definitions,
          { id: 'f-plat', name: 'platform', display_name: 'Platform', field_type: 'string', is_required: true, order: 3 },
        ],
      } as unknown as EventType,
    ])
    render(createElement(EventBulkForm), { wrapper })
    await chooseType()

    expect(await screen.findByRole('alert')).toHaveTextContent(/needs platform/)
    expect(screen.queryByLabelText('Events to create')).not.toBeInTheDocument()
  })
})
