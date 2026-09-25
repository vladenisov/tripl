import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContextValue } from '@/components/auth-context'
import { AuthContext } from '@/components/auth-context'
import { authAs } from '@/test/auth'
import { eventTypesApi } from '@/api/eventTypes'
import { relationsApi } from '@/api/relations'
import type { EventType, EventTypeRelation } from '@/types'
import { RelationsTab } from './RelationsTab'

vi.mock('@/api/relations', () => ({
  relationsApi: { list: vi.fn(), create: vi.fn(), del: vi.fn() },
}))
vi.mock('@/api/eventTypes', () => ({
  eventTypesApi: { list: vi.fn() },
}))

const TYPES = [
  { id: 'et-1', name: 'purchase', display_name: 'Purchase', field_definitions: [{ id: 'f-1', name: 'user_id' }] },
  { id: 'et-2', name: 'signup', display_name: 'Signup', field_definitions: [{ id: 'f-2', name: 'user_id' }] },
] as unknown as EventType[]

const RELATION = {
  id: 'rel-1',
  source_event_type_id: 'et-1',
  target_event_type_id: 'et-2',
  source_field_id: 'f-1',
  target_field_id: 'f-2',
  relation_type: 'shared_field',
} as unknown as EventTypeRelation

function renderTab(auth: AuthContextValue | null, { seed = true }: { seed?: boolean } = {}) {
  if (seed) vi.mocked(relationsApi.list).mockResolvedValue([RELATION])
  vi.mocked(eventTypesApi.list).mockResolvedValue(TYPES)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <RelationsTab slug="demo" />
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('RelationsTab', () => {
  it('offers an editor Add and Delete', async () => {
    renderTab(authAs('editor'))

    expect(
      await screen.findByRole('button', { name: 'Delete relation between purchase.user_id and signup.user_id' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New relation/ })).toBeInTheDocument()
  })

  it('offers a viewer neither, and says why once', async () => {
    renderTab(authAs('viewer'))

    expect(await screen.findByText('purchase.user_id')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/viewer role/)
    expect(screen.queryByRole('button', { name: /New relation/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete relation/ })).not.toBeInTheDocument()
  })

  it('names the joined fields in each row and in the delete confirm (PLAN-52)', async () => {
    renderTab(authAs('editor'))

    expect(await screen.findByText('purchase.user_id')).toBeInTheDocument()
    expect(screen.getByText('signup.user_id')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete relation between purchase.user_id and signup.user_id' }),
    )
    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Remove the relation purchase.user_id → signup.user_id?')).toBeInTheDocument()
  })

  it('says a failed delete failed instead of leaving the row in silence', async () => {
    vi.mocked(relationsApi.del).mockRejectedValue(new Error('Relation is in use'))
    renderTab(authAs('editor'))

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete relation between purchase.user_id and signup.user_id' }),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Relation is in use')
  })

  it('shows a skeleton, not "No relations", while the list loads (PLAN-41)', async () => {
    vi.mocked(relationsApi.list).mockReturnValue(new Promise(() => {}))
    renderTab(authAs('editor'), { seed: false })

    expect(await screen.findByLabelText('Loading relations')).toBeInTheDocument()
    expect(screen.queryByText('No relations')).not.toBeInTheDocument()
  })

  it('shows a failed load as an error with a retry, not as an empty list (PLAN-41)', async () => {
    vi.mocked(relationsApi.list).mockRejectedValue(new Error('boom'))
    renderTab(authAs('editor'), { seed: false })

    expect(await screen.findByText("Couldn't load relations")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No relations')).not.toBeInTheDocument()
  })
})
