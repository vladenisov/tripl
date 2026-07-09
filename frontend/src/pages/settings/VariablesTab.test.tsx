import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventsApi } from '@/api/events'
import { variablesApi } from '@/api/variables'
import { variableOverridesApi } from '@/api/variableOverrides'
import { VariablesTab } from './VariablesTab'

vi.mock('@/api/variables', () => ({
  variablesApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
    values: vi.fn(),
    bulkUpdate: vi.fn(),
    bulkDelete: vi.fn(),
  },
}))

vi.mock('@/api/variableOverrides', () => ({
  variableOverridesApi: {
    list: vi.fn(),
    upsert: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('@/api/events', () => ({
  eventsApi: {
    list: vi.fn(),
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
        allowed_values: [],
        bindings: [],
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
        allowed_values: [],
        bindings: [],
        description: '',
      },
      {
        id: 'var-2',
        project_id: 'project-1',
        name: 'user_id',
        source_name: 'user_id',
        variable_type: 'string',
        allowed_values: [],
        bindings: [],
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
        allowed_values: [],
        bindings: [],
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

  it('creates a variable with documented values and bindings', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([])
    vi.mocked(variablesApi.create).mockResolvedValue({
      id: 'var-new',
      project_id: 'p',
      name: 'variant',
      source_name: null,
      variable_type: 'string',
      allowed_values: ['a'],
      bindings: ['page_data.extra.variant'],
      description: '',
    })

    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: /add variable/i }))
    fireEvent.change(screen.getByPlaceholderText('my_variable'), { target: { value: 'variant' } })

    const valueInput = screen.getByLabelText('Add possible value')
    fireEvent.change(valueInput, { target: { value: 'a' } })
    fireEvent.keyDown(valueInput, { key: 'Enter' })

    const bindingInput = screen.getByLabelText('Add data binding')
    fireEvent.change(bindingInput, { target: { value: 'page_data.extra.variant' } })
    fireEvent.keyDown(bindingInput, { key: 'Enter' })

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() =>
      expect(variablesApi.create).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({
          name: 'variant',
          allowed_values: ['a'],
          bindings: ['page_data.extra.variant'],
        }),
        null,
      ),
    )
  })

  it('rejects an invalid binding path in the chip input', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([])
    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: /add variable/i }))

    const bindingInput = screen.getByLabelText('Add data binding')
    fireEvent.change(bindingInput, { target: { value: 'not a path!' } })
    fireEvent.keyDown(bindingInput, { key: 'Enter' })

    expect(await screen.findByText(/invalid path/i)).toBeInTheDocument()
  })

  it('saves a per-event override from the edit dialog', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([
      {
        id: 'var-1',
        project_id: 'p',
        name: 'variant',
        source_name: 'page_data.extra.variant',
        variable_type: 'string',
        allowed_values: ['a', 'b'],
        bindings: ['page_data.extra.variant'],
        description: '',
      },
    ])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableOverridesApi.list).mockResolvedValue([
      {
        id: 'ovr-1',
        variable_id: 'var-1',
        event_id: 'ev-1',
        event_name: 'Onboarding',
        values: ['x'],
      },
    ])
    vi.mocked(eventsApi.list).mockResolvedValue({
      items: [
        { id: 'ev-1', name: 'Onboarding' },
        { id: 'ev-2', name: 'Checkout' },
      ] as never,
      total: 2,
    })
    vi.mocked(variableOverridesApi.upsert).mockResolvedValue({
      id: 'ovr-2',
      variable_id: 'var-1',
      event_id: 'ev-2',
      event_name: 'Checkout',
      values: ['y'],
    })

    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit variable variant' }))

    // Existing override renders with its event name and values.
    expect(
      await screen.findByRole('button', { name: 'Edit override for Onboarding' }),
    ).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Override event'), { target: { value: 'ev-2' } })
    const overrideInput = screen.getByLabelText('Add override value')
    fireEvent.change(overrideInput, { target: { value: 'y' } })
    fireEvent.keyDown(overrideInput, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() =>
      expect(variableOverridesApi.upsert).toHaveBeenCalledWith('demo', 'var-1', 'ev-2', ['y'], null),
    )
  })

  it('keeps a legacy dotted name editable while unchanged but restricts renames', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([
      {
        id: 'var-legacy',
        project_id: 'p',
        name: 'page_data.extra.variant',
        source_name: 'page_data.extra.variant',
        variable_type: 'string',
        allowed_values: [],
        bindings: ['page_data.extra.variant'],
        description: '',
      },
    ])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableOverridesApi.list).mockResolvedValue([])
    vi.mocked(eventsApi.list).mockResolvedValue({ items: [] as never, total: 0 })

    renderVariablesTab()
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit variable page_data.extra.variant' }),
    )

    const nameInput = screen.getByPlaceholderText('variable_name') as HTMLInputElement
    // Unchanged legacy dotted name → no pattern restriction.
    expect(nameInput.value).toBe('page_data.extra.variant')
    expect(nameInput).not.toHaveAttribute('pattern')

    // Renaming applies the strict dot-free pattern.
    fireEvent.change(nameInput, { target: { value: 'page_data.renamed' } })
    expect(nameInput).toHaveAttribute('pattern', '^[a-z][a-z0-9_]*$')
    expect(nameInput.validity.patternMismatch).toBe(true)
  })

  it('bulk-updates selected variables from the bulk bar', async () => {
    vi.mocked(variablesApi.list).mockResolvedValue([
      {
        id: 'var-1',
        project_id: 'p',
        name: 'one',
        source_name: null,
        variable_type: 'string',
        allowed_values: [],
        bindings: [],
        description: '',
      },
      {
        id: 'var-2',
        project_id: 'p',
        name: 'two',
        source_name: null,
        variable_type: 'string',
        allowed_values: [],
        bindings: [],
        description: '',
      },
    ])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variablesApi.bulkUpdate).mockResolvedValue(undefined)

    renderVariablesTab()

    fireEvent.click(await screen.findByLabelText('Select variable one'))
    fireEvent.click(screen.getByLabelText('Select variable two'))
    expect(screen.getByText('2')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Bulk set type'), { target: { value: 'number' } })
    await waitFor(() =>
      expect(variablesApi.bulkUpdate).toHaveBeenCalledWith(
        'demo',
        { variable_ids: ['var-1', 'var-2'], variable_type: 'number' },
        null,
      ),
    )

    fireEvent.change(screen.getByLabelText('Bulk add values'), { target: { value: 'a, b' } })
    fireEvent.keyDown(screen.getByLabelText('Bulk add values'), { key: 'Enter' })
    await waitFor(() =>
      expect(variablesApi.bulkUpdate).toHaveBeenCalledWith(
        'demo',
        { variable_ids: ['var-1', 'var-2'], allowed_values_add: ['a', 'b'] },
        null,
      ),
    )
  })
})
