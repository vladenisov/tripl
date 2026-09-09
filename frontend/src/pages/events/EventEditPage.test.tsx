import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { eventCommentsApi } from '@/api/eventComments'
import { eventsApi } from '@/api/events'
import type { EventType } from '@/types'

import EventEditPage from './EventForm'

vi.mock('@/api/events', () => ({
  eventsApi: {
    create: vi.fn(),
    update: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  },
}))
vi.mock('@/api/eventComments', () => ({
  eventCommentsApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    remove: vi.fn(),
    action: vi.fn(),
  },
}))
vi.mock('@/api/eventTypes', () => ({
  eventTypesApi: { list: vi.fn() },
}))
vi.mock('@/api/metaFields', () => ({
  metaFieldsApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/api/variables', () => ({
  variablesApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/api/users', () => ({
  usersApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/api/planBranches', () => ({
  planBranchesApi: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) },
}))
vi.mock('@/api/scans', () => ({
  scansApi: { list: vi.fn().mockResolvedValue([]) },
}))
vi.mock('@/api/ai', () => ({
  aiApi: {
    status: vi.fn().mockResolvedValue({ enabled: false }),
    describeEvent: vi.fn(),
  },
}))

const EVENT_TYPE = {
  id: 'et-1',
  name: 'checkout',
  display_name: 'Checkout',
  field_definitions: [],
} as unknown as EventType

const CREATED = {
  id: 'ev-new',
  event_type_id: 'et-1',
  name: 'checkout:completed',
  title: '',
  description: '',
  status: 'draft',
  sunset_at: null,
  metric_breakdown_columns: [],
  tags: [],
  field_values: [],
  meta_values: [],
  warnings: [],
}

let queryClient: QueryClient

beforeEach(async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { eventTypesApi } = await import('@/api/eventTypes')
  vi.mocked(eventTypesApi.list).mockResolvedValue([EVENT_TYPE])
  vi.mocked(eventsApi.create).mockResolvedValue(CREATED as never)
  vi.mocked(eventsApi.get).mockResolvedValue({ ...CREATED, branch_id: null } as never)
})

afterEach(() => {
  queryClient.clear()
  vi.clearAllMocks()
})

function renderAtNew() {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/events/all/new']}>
        <Routes>
          <Route path="/p/:slug/events/:tab/new" element={<EventEditPage />} />
          <Route path="/p/:slug/events/:tab/:eventId/edit" element={<EventEditPage />} />
          <Route path="/p/:slug/events/:tab" element={<div>events list</div>} />
          <Route path="/p/:slug/events" element={<div>events list</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function fillAndCreate(note: string) {
  const composer = await screen.findByLabelText(/posted as the first comment/i)
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'checkout:completed' } })
  fireEvent.change(composer, { target: { value: note } })
  fireEvent.click(screen.getByRole('button', { name: 'Create event' }))
}

/**
 * tripl-htfn.1 — "comments appeared, but only after creating and then editing
 * an event; at the moment of creating one there are no comments."
 */
describe('EventEditPage — a question raised while the event is being authored', () => {
  it('offers the discussion box on the create form, saying it is not the spec', async () => {
    renderAtNew()

    const composer = await screen.findByLabelText(/posted as the first comment/i)
    expect(composer).toBeInTheDocument()
    // The distinction is the whole reason this box is not Description: every
    // other field travels with the event into the implementer's spec.
    expect(screen.getByText(/kept out of the spec/i)).toBeInTheDocument()
  })

  it('posts the drafted note against the event that was just created', async () => {
    vi.mocked(eventCommentsApi.create).mockResolvedValue({} as never)
    renderAtNew()

    await fillAndCreate('Should this fire on cancel too?')

    await waitFor(() => expect(eventsApi.create).toHaveBeenCalled())
    // The id comes from the CREATE response, not from the route — there is no
    // event id in the route this was posted from.
    await waitFor(() =>
      expect(eventCommentsApi.create).toHaveBeenCalledWith(
        'demo',
        'ev-new',
        'Should this fire on cancel too?',
        null,
      ),
    )
  })

  it('posts nothing when the box was left empty', async () => {
    renderAtNew()

    await screen.findByLabelText(/posted as the first comment/i)
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'checkout:completed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create event' }))

    await waitFor(() => expect(eventsApi.create).toHaveBeenCalled())
    expect(eventCommentsApi.create).not.toHaveBeenCalled()
  })

  it('keeps the words when the note fails to post, on the event that now exists', async () => {
    // The event is created and the comment request fails. Closing the form here
    // would drop what the author wrote, and leaving them on a create form for
    // an event that already exists invites a duplicate.
    vi.mocked(eventCommentsApi.create).mockRejectedValue(new Error('network is down'))
    renderAtNew()

    await fillAndCreate('Does this fire on cancel?')

    // Landed on the created event, so its thread is what is on screen…
    const restored = await screen.findByLabelText('Write a comment')
    expect(restored).toHaveValue('Does this fire on cancel?')
    // …and the reason it is still a draft is stated rather than swallowed.
    expect(await screen.findByRole('alert')).toHaveTextContent(/note was not posted/i)
    expect(screen.queryByText('events list')).not.toBeInTheDocument()
  })
})
