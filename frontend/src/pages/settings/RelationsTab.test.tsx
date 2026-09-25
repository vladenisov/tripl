import { render, screen } from '@testing-library/react'
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
  { id: 'et-1', name: 'purchase', display_name: 'Purchase', field_definitions: [] },
  { id: 'et-2', name: 'signup', display_name: 'Signup', field_definitions: [] },
] as unknown as EventType[]

const RELATION = {
  id: 'rel-1',
  source_event_type_id: 'et-1',
  target_event_type_id: 'et-2',
  source_field_id: 'f-1',
  target_field_id: 'f-2',
  relation_type: 'shared_field',
} as unknown as EventTypeRelation

function renderTab(auth: AuthContextValue | null) {
  vi.mocked(relationsApi.list).mockResolvedValue([RELATION])
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
      await screen.findByRole('button', { name: 'Delete relation between purchase and signup' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add relation/ })).toBeInTheDocument()
  })

  it('offers a viewer neither, and says why once', async () => {
    renderTab(authAs('viewer'))

    expect(await screen.findByText('purchase')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/viewer role/)
    expect(screen.queryByRole('button', { name: /Add relation/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete relation/ })).not.toBeInTheDocument()
  })
})
