import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  it('groups a variable into one row and lists its events as a sub-list', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([
      {
        id: 'var-1',
        project_id: 'project-1',
        name: 'spot_id',
        source_name: 'spot_id',
        variable_type: 'string',
        description: 'Spot identifier',
        event_count: 2,
        context_count: 2,
        low_context_count: 1,
        high_context_count: 1,
        sample_values: ['s1', 's2'],
      },
    ])
    // One variable referenced by two events => two contexts. The page must show
    // a single variable row with both events nested, not two duplicate rows.
    vi.mocked(variablesApi.values).mockResolvedValue([
      {
        id: 'ctx-1',
        variable_id: 'var-1',
        variable_name: 'spot_id',
        event_id: 'ev-1',
        event_name: 'Profile View',
        field_definition_id: 'fd-1',
        field_name: 'spot_id',
        field_display_name: 'Spot ID',
        source_column: 'spot_id',
        value_kind: 'low',
        observed_count: 2,
        values: ['s1', 's2'],
      },
      {
        id: 'ctx-2',
        variable_id: 'var-1',
        variable_name: 'spot_id',
        event_id: 'ev-2',
        event_name: 'Checkout Started',
        field_definition_id: 'fd-2',
        field_name: 'spot_id',
        field_display_name: 'Spot ID',
        source_column: 'spot_id',
        value_kind: 'high',
        observed_count: 5,
        values: ['s2', 's3'],
      },
    ])

    renderVariablesTab()

    await waitFor(() => expect(variablesApi.list).toHaveBeenCalled())
    await waitFor(() => expect(variablesApi.values).toHaveBeenCalledWith('demo', 'var-1', null))
    expect(screen.getByRole('columnheader', { name: 'Events' })).toBeInTheDocument()

    // Exactly one body row (the single variable), not one per event.
    const varCode = await screen.findByText('${spot_id}')
    const bodyRow = varCode.closest('tr') as HTMLElement
    expect(within(bodyRow).getByText('Profile View')).toBeInTheDocument()
    expect(within(bodyRow).getByText('Checkout Started')).toBeInTheDocument()

    // The variable placeholder is rendered once, so no duplicate rows exist.
    expect(screen.getAllByText('${spot_id}')).toHaveLength(1)

    // Values are unioned across contexts and de-duplicated (s2 appears once).
    expect(screen.getAllByText('s2')).toHaveLength(1)
    expect(screen.getByText('s3')).toBeInTheDocument()
  })

  it('header counts distinct variables, agreeing with the sidebar badge semantics', async () => {
    // Two distinct variables, one of which spans two events (two contexts). The
    // header must read "2 variables" (distinct) — the same count the sidebar
    // badge derives from summary.variable_count — not 3 (context rows).
    vi.mocked(variablesApi.list).mockResolvedValue([
      {
        id: 'var-1',
        project_id: 'project-1',
        name: 'spot_id',
        source_name: 'spot_id',
        variable_type: 'string',
        description: '',
      },
      {
        id: 'var-2',
        project_id: 'project-1',
        name: 'user_id',
        source_name: 'user_id',
        variable_type: 'string',
        description: '',
      },
    ])
    vi.mocked(variablesApi.values).mockImplementation((_slug, id) =>
      Promise.resolve(
        id === 'var-1'
          ? [
              {
                id: 'ctx-1',
                variable_id: 'var-1',
                variable_name: 'spot_id',
                event_id: 'ev-1',
                event_name: 'Profile View',
                field_definition_id: 'fd-1',
                field_name: 'spot_id',
                field_display_name: 'Spot ID',
                source_column: 'spot_id',
                value_kind: 'low',
                observed_count: 2,
                values: ['s1'],
              },
              {
                id: 'ctx-2',
                variable_id: 'var-1',
                variable_name: 'spot_id',
                event_id: 'ev-2',
                event_name: 'Checkout Started',
                field_definition_id: 'fd-2',
                field_name: 'spot_id',
                field_display_name: 'Spot ID',
                source_column: 'spot_id',
                value_kind: 'low',
                observed_count: 2,
                values: ['s2'],
              },
            ]
          : [],
      ),
    )

    renderVariablesTab()

    await waitFor(() => expect(variablesApi.values).toHaveBeenCalledWith('demo', 'var-1', null))
    expect(await screen.findByText('2 variables')).toBeInTheDocument()
  })

  it('shows all observed values when editing a variable', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([
      {
        id: 'var-1',
        project_id: 'project-1',
        name: 'user_id',
        source_name: 'user_id',
        variable_type: 'string',
        description: 'User identifier',
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

    await waitFor(() => expect(variablesApi.values).toHaveBeenCalled())
    const row = screen.getByText('Profile View').closest('tr')
    expect(row).not.toBeNull()
    fireEvent.click(within(row as HTMLElement).getAllByRole('button')[0])

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Edit: user_id')).toBeInTheDocument()
    expect(within(dialog).getByText('Observed values')).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Variable' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Type' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Event' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Description' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Possible values' })).toBeInTheDocument()
    expect(within(dialog).getByText('Profile View')).toBeInTheDocument()
    expect(within(dialog).getByText('u1')).toBeInTheDocument()
    expect(within(dialog).getByText('u2')).toBeInTheDocument()
  })
})
