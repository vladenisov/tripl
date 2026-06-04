import { render, screen } from '@testing-library/react'
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
  it('renders observed variable value summaries', async () => {
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

    renderVariablesTab()

    expect(await screen.findByText('${user_id}')).toBeInTheDocument()
    expect(screen.getByText('2 events')).toBeInTheDocument()
    expect(screen.getByText('3 contexts')).toBeInTheDocument()
    expect(screen.getByText('1 sampled')).toBeInTheDocument()
    expect(screen.getByText('u1')).toBeInTheDocument()
    expect(screen.getByText('u2')).toBeInTheDocument()
  })
})
