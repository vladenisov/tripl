import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { variablesApi } from '@/api/variables'
import { VariablesTab } from './VariablesTab'

vi.mock('@/api/variables', () => ({
  variablesApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
    values: vi.fn(),
  },
}))

function renderVariablesTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <VariablesTab slug="demo" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('VariablesTab', () => {
  it('renders variable rows per attached event with possible values', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([
      {
        id: 'var-1',
        project_id: 'project-1',
        name: 'user_id',
        source_name: 'user_id',
        variable_type: 'string',
        description: 'User identifier',
        event_count: 2,
        context_count: 3,
        low_context_count: 2,
        high_context_count: 1,
        sample_values: ['u1', 'u2'],
      },
    ])
    vi.mocked(variablesApi.values).mockResolvedValue([
      {
        id: 'ctx-1',
        variable_id: 'var-1',
        variable_name: 'user_id',
        event_id: 'ev-1',
        event_name: 'Profile View',
        field_definition_id: 'fd-1',
        field_name: 'user_id',
        field_display_name: 'User ID',
        source_column: 'user_id',
        value_kind: 'low',
        observed_count: 2,
        values: ['u1', 'u2'],
      },
    ])

    renderVariablesTab()

    await waitFor(() => expect(variablesApi.list).toHaveBeenCalled())
    await waitFor(() => expect(variablesApi.values).toHaveBeenCalledWith('demo', 'var-1', null))
    expect(await screen.findByText('Profile View')).toBeInTheDocument()
    expect(screen.getByText('u1')).toBeInTheDocument()
    expect(screen.getByText('u2')).toBeInTheDocument()
  })
})
