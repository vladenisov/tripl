import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { eventsApi } from '@/api/events'
import { variablesApi } from '@/api/variables'
import { variableDriftsApi } from '@/api/variableDrifts'
import { variableOverridesApi } from '@/api/variableOverrides'
import type { Variable } from '@/types'
import { VariablesTab } from './VariablesTab'

vi.mock('@/api/variables', () => ({
  variablesApi: {
    list: vi.fn(),
    listPage: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
    values: vi.fn(),
    bulkUpdate: vi.fn(),
    bulkDelete: vi.fn(),
  },
}))

vi.mock('@/api/variableDrifts', () => ({
  variableDriftsApi: {
    list: vi.fn(),
    action: vi.fn(),
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

function makeVariable(overrides: Partial<Variable> & { id: string; name: string }): Variable {
  return {
    project_id: 'project-1',
    source_name: null,
    variable_type: 'string',
    allowed_values: [],
    bindings: [],
    description: '',
    ...overrides,
  }
}

/** The list endpoint returns a page envelope; every test seeds it through here. */
function mockList(items: Variable[], total = items.length) {
  vi.mocked(variablesApi.listPage).mockResolvedValue({ items, total })
}

function renderVariablesTab(props: { focusId?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <VariablesTab slug="demo" {...props} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('VariablesTab', () => {
  it('renders a row from the list response alone — no per-variable request', async () => {
    // One variable referenced by two events. Both event names and the unioned
    // observed values ship with the list row, so the page must not issue the
    // per-variable /values call that used to fan out once per row (tripl-jfm3.10).
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'spot_id',
        source_name: 'spot_id',
        description: 'Spot identifier',
        event_count: 2,
        event_names: ['Checkout Started', 'Profile View'],
        context_count: 2,
        sample_values: ['s1', 's2', 's3'],
      }),
    ])

    renderVariablesTab()

    await waitFor(() => expect(variablesApi.listPage).toHaveBeenCalledTimes(1))

    // Exactly one body row (the single variable), not one per event.
    const varCode = await screen.findByText('${spot_id}')
    expect(screen.getByRole('columnheader', { name: 'Events' })).toBeInTheDocument()
    const bodyRow = varCode.closest('tr') as HTMLElement
    expect(within(bodyRow).getByText('Profile View')).toBeInTheDocument()
    expect(within(bodyRow).getByText('Checkout Started')).toBeInTheDocument()
    expect(screen.getAllByText('${spot_id}')).toHaveLength(1)

    // Observed values come straight off the row.
    expect(within(bodyRow).getByText('s1')).toBeInTheDocument()
    expect(within(bodyRow).getByText('s3')).toBeInTheDocument()

    // The regression this test exists for: zero per-variable requests.
    expect(variablesApi.values).not.toHaveBeenCalled()
    expect(variablesApi.list).not.toHaveBeenCalled()
  })

  it('header counts distinct variables, agreeing with the sidebar badge semantics', async () => {
    // Two distinct variables, one of which spans two events. The header must
    // read "2 variables" (distinct) — the same count the sidebar badge derives
    // from summary.variable_count — not 3 (context rows).
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'spot_id',
        source_name: 'spot_id',
        event_count: 2,
        event_names: ['Checkout Started', 'Profile View'],
      }),
      makeVariable({ id: 'var-2', name: 'user_id', source_name: 'user_id' }),
    ])

    renderVariablesTab()

    expect(await screen.findByText('2 variables')).toBeInTheDocument()
  })

  it('shows a loading skeleton, not the empty state, while the list is pending', async () => {
    // The list resolving to [] and the list still loading are different things;
    // conflating them flashed "No variables" over a 1.2k-variable project
    // (tripl-jfm3.52).
    vi.mocked(variablesApi.listPage).mockReturnValue(new Promise(() => {}))

    renderVariablesTab()

    expect(await screen.findByLabelText('Loading variables')).toBeInTheDocument()
    expect(screen.queryByText('No variables')).not.toBeInTheDocument()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('renders the empty state once the list resolves empty', async () => {
    mockList([])

    renderVariablesTab()

    expect(await screen.findByText('No variables')).toBeInTheDocument()
    expect(screen.queryByLabelText('Loading variables')).not.toBeInTheDocument()
  })

  it('renders one page of rows for a large project instead of all of them', async () => {
    // 120 variables must not become 120 rows: the unwindowed table was the
    // reason one checkbox click took hundreds of ms (tripl-jfm3.49).
    mockList(
      Array.from({ length: 120 }, (_, index) =>
        makeVariable({ id: `var-${index}`, name: `var_${String(index).padStart(3, '0')}` }),
      ),
    )

    renderVariablesTab()

    await screen.findByText('${var_000}')
    expect(screen.getAllByRole('row')).toHaveLength(51) // 50 body rows + header
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Showing 1–50 of 120')).toBeInTheDocument()
    expect(screen.queryByText('${var_050}')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))

    expect(await screen.findByText('${var_050}')).toBeInTheDocument()
    expect(screen.queryByText('${var_000}')).not.toBeInTheDocument()
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
  })

  it('filters the whole set, not just the visible page', async () => {
    mockList(
      Array.from({ length: 120 }, (_, index) =>
        makeVariable({ id: `var-${index}`, name: `var_${String(index).padStart(3, '0')}` }),
      ),
    )

    renderVariablesTab()
    await screen.findByText('${var_000}')

    // var_117 sits on page 3 — the filter must reach it from page 1.
    fireEvent.change(screen.getByLabelText('Filter variables'), { target: { value: 'var_117' } })

    expect(await screen.findByText('${var_117}')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2) // header + the single match
    expect(screen.queryByText('Page 1 of 3')).not.toBeInTheDocument()
  })

  it('finds a variable by the warehouse path it binds to, not just its display name', async () => {
    // derive_display_name slugs a dotted path down to its last segment, so the
    // name on screen is `${aalter}` while the only name a person knows is
    // `property.Aalter`. 576 production rows are in exactly this state.
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'aalter',
        source_name: 'property.Aalter',
        bindings: ['property.Aalter'],
      }),
      makeVariable({ id: 'var-2', name: 'user_id', source_name: 'user_id' }),
    ])

    renderVariablesTab()
    await screen.findByText('${aalter}')

    fireEvent.change(screen.getByLabelText('Filter variables'), { target: { value: 'property.' } })

    expect(await screen.findByText('${aalter}')).toBeInTheDocument()
    expect(screen.queryByText('${user_id}')).not.toBeInTheDocument()
  })

  it('asks the server for the unused set instead of narrowing it here', async () => {
    // "Unused" cannot be computed on this page: it depends on whether any event
    // field or meta value still names the token, which the page never loads.
    // Deciding it locally would put rows that ARE referenced under a select-all
    // checkbox (tripl-xfxa).
    mockList([makeVariable({ id: 'var-1', name: 'spot_id', source_name: 'spot_id' })])

    renderVariablesTab()
    await screen.findByText('${spot_id}')
    expect(variablesApi.listPage).toHaveBeenCalledWith('demo', null, { usage: 'all' })

    fireEvent.click(screen.getByRole('button', { name: 'Unused' }))

    await waitFor(() =>
      expect(variablesApi.listPage).toHaveBeenCalledWith('demo', null, { usage: 'unused' }),
    )
  })

  it('paginates to the page holding the focused variable', async () => {
    mockList(
      Array.from({ length: 120 }, (_, index) =>
        makeVariable({ id: `var-${index}`, name: `var_${String(index).padStart(3, '0')}` }),
      ),
    )

    renderVariablesTab({ focusId: 'var-117' })

    expect(await screen.findByText('${var_117}')).toBeInTheDocument()
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument()
  })

  it('shows all observed values when editing a variable', async () => {
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'user_id',
        source_name: 'user_id',
        description: 'User identifier',
        event_count: 1,
        event_names: ['Profile View'],
        sample_values: ['u1'],
      }),
    ])
    // The full per-event breakdown is fetched for the edited variable only.
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

    fireEvent.click(await screen.findByRole('button', { name: 'Edit variable user_id' }))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(variablesApi.values).toHaveBeenCalledWith('demo', 'var-1', null),
    )
    expect(variablesApi.values).toHaveBeenCalledTimes(1)
    expect(within(dialog).getByText('Edit: user_id')).toBeInTheDocument()
    expect(within(dialog).getByText('Observed values')).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Variable' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Type' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Event' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Description' })).toBeInTheDocument()
    expect(within(dialog).getByRole('columnheader', { name: 'Possible values' })).toBeInTheDocument()
    expect(await within(dialog).findByText('u2')).toBeInTheDocument()
  })

  it('creates a variable with documented values and bindings', async () => {
    mockList([])
    vi.mocked(variablesApi.create).mockResolvedValue(
      makeVariable({
        id: 'var-new',
        name: 'variant',
        allowed_values: ['a'],
        bindings: ['page_data.extra.variant'],
      }),
    )

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
    mockList([])
    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: /add variable/i }))

    const bindingInput = screen.getByLabelText('Add data binding')
    fireEvent.change(bindingInput, { target: { value: 'not a path!' } })
    fireEvent.keyDown(bindingInput, { key: 'Enter' })

    expect(await screen.findByText(/invalid path/i)).toBeInTheDocument()
  })

  it('saves a per-event override from the edit dialog', async () => {
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'variant',
        source_name: 'page_data.extra.variant',
        allowed_values: ['a', 'b'],
        bindings: ['page_data.extra.variant'],
      }),
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

  it('names a blank-named event in the override picker and its row actions (tripl-wkwv.5)', async () => {
    // windy-ios holds exactly one event whose stored name is ''. A native
    // <option> takes its accessible name from its text content, so that row was
    // a selectable option announced as nothing — indistinguishable from a
    // rendering glitch — and the two icon buttons on its existing override read
    // "Edit override for " / "Delete override for ": a trailing space and no
    // more (tripl-wkwv.5).
    mockList([makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a'] })])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableOverridesApi.list).mockResolvedValue([
      { id: 'ovr-1', variable_id: 'var-1', event_id: 'ev-blank', event_name: '', values: ['x'] },
    ])
    vi.mocked(eventsApi.list).mockResolvedValue({
      items: [{ id: 'ev-blank', name: '' }] as never,
      total: 1,
    })

    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit variable variant' }))

    expect(
      await screen.findByRole('button', { name: 'Edit override for (unnamed event)' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete override for (unnamed event)' }),
    ).toBeInTheDocument()
    // The picker itself, whose only other row is the "Select event…" placeholder.
    expect(
      await screen.findByRole('option', { name: '(unnamed event)' }),
    ).toBeInTheDocument()
  })

  it('keeps a legacy dotted name editable while unchanged but restricts renames', async () => {
    mockList([
      makeVariable({
        id: 'var-legacy',
        name: 'page_data.extra.variant',
        source_name: 'page_data.extra.variant',
        bindings: ['page_data.extra.variant'],
      }),
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
    mockList([
      makeVariable({ id: 'var-1', name: 'one' }),
      makeVariable({ id: 'var-2', name: 'two' }),
    ])
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

  it('select-all covers every matching variable, including off-page ones', async () => {
    mockList(
      Array.from({ length: 60 }, (_, index) =>
        makeVariable({ id: `var-${index}`, name: `var_${String(index).padStart(3, '0')}` }),
      ),
    )
    vi.mocked(variablesApi.bulkUpdate).mockResolvedValue(undefined)

    renderVariablesTab()
    await screen.findByText('${var_000}')

    fireEvent.click(screen.getByLabelText('Select all variables'))
    expect(screen.getByText('60')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Bulk set type'), { target: { value: 'number' } })
    await waitFor(() => expect(variablesApi.bulkUpdate).toHaveBeenCalled())
    const [, payload] = vi.mocked(variablesApi.bulkUpdate).mock.calls[0]
    expect(payload.variable_ids).toHaveLength(60)
    expect(payload.variable_ids).toContain('var-59')
  })

  it('shows a drift badge and accepts drift values into the documented list', async () => {
    mockList([
      makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a'], open_drift_count: 1 }),
    ])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableOverridesApi.list).mockResolvedValue([])
    vi.mocked(eventsApi.list).mockResolvedValue({ items: [] as never, total: 0 })
    vi.mocked(variableDriftsApi.list).mockResolvedValue({
      items: [
        {
          id: 'drift-1',
          variable_id: 'var-1',
          variable_name: 'variant',
          event_id: 'ev-1',
          event_name: 'Onboarding',
          scan_config_id: null,
          observed_values: ['x', 'y'],
          status: 'open',
          resolution_note: null,
          snoozed_until: null,
          resolved_at: null,
          resolved_by: null,
          detected_at: '2026-07-09T00:00:00Z',
        },
      ],
      total: 1,
    })
    vi.mocked(variableDriftsApi.action).mockResolvedValue({} as never)

    renderVariablesTab()

    // Row badge from open_drift_count.
    expect(await screen.findByText('1 drift')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit variable variant' }))
    expect(
      await screen.findByText(/value drift — observed values outside/i),
    ).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(variableDriftsApi.action).toHaveBeenCalledWith(
        'demo',
        'drift-1',
        { action: 'accept', scope: 'global', snoozed_until: undefined },
        null,
      ),
    )
  })

  it('reveals an accepted drift behind the resolved toggle and reopens it', async () => {
    mockList([
      makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a', 'x'], open_drift_count: 0 }),
    ])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableOverridesApi.list).mockResolvedValue([])
    vi.mocked(eventsApi.list).mockResolvedValue({ items: [] as never, total: 0 })
    vi.mocked(variableDriftsApi.list).mockResolvedValue({
      items: [
        {
          id: 'drift-1',
          variable_id: 'var-1',
          variable_name: 'variant',
          event_id: 'ev-1',
          event_name: 'Onboarding',
          scan_config_id: null,
          observed_values: ['x'],
          status: 'accepted',
          resolution_note: null,
          snoozed_until: null,
          resolved_at: '2026-07-10T00:00:00Z',
          resolved_by: null,
          detected_at: '2026-07-09T00:00:00Z',
        },
      ],
      total: 1,
    })
    vi.mocked(variableDriftsApi.action).mockResolvedValue({} as never)

    renderVariablesTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit variable variant' }))
    // The panel still renders with nothing open, otherwise the acceptance is
    // unreachable and cannot be undone.
    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 resolved' }))
    expect(await screen.findByText('accepted')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() =>
      expect(variableDriftsApi.action).toHaveBeenCalledWith(
        'demo',
        'drift-1',
        { action: 'reopen', scope: undefined, snoozed_until: undefined },
        null,
      ),
    )
  })

  it('excludes a variable from scans and restores it from the excluded section', async () => {
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'variant',
        source_name: 'payload.variant',
        bindings: ['payload.variant'],
      }),
      makeVariable({
        id: 'var-2',
        name: 'old_junk',
        source_name: 'old.junk',
        excluded_from_scans: true,
      }),
    ])
    vi.mocked(variablesApi.update).mockResolvedValue({} as never)

    renderVariablesTab()

    // Excluded variable lives in its own section, not the main table.
    expect(await screen.findByText('Excluded from scans')).toBeInTheDocument()
    expect(screen.getByText('${old_junk}')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit variable old_junk' })).not.toBeInTheDocument()

    // Exclude an active variable (confirm dialog -> update with the flag).
    fireEvent.click(screen.getByRole('button', { name: 'Exclude variable variant from scans' }))
    expect(await screen.findByText(/future scans will NOT re-create it/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Exclude' }))
    await waitFor(() =>
      expect(variablesApi.update).toHaveBeenCalledWith(
        'demo',
        'var-1',
        { excluded_from_scans: true },
        null,
      ),
    )

    // Restore from the excluded section clears the tombstone.
    fireEvent.click(screen.getByRole('button', { name: 'Restore variable old_junk' }))
    await waitFor(() =>
      expect(variablesApi.update).toHaveBeenCalledWith(
        'demo',
        'var-2',
        { excluded_from_scans: false },
        null,
      ),
    )
  })

  it('scopes the exclude promise to the act, not to a permanence it cannot enforce', async () => {
    mockList([makeVariable({ id: 'var-1', name: 'variant', source_name: 'payload.variant' })])

    renderVariablesTab()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Exclude variable variant from scans' }),
    )

    // What excluding does is a fact about this button; what every later scan
    // does to the records is not this dialog's to guarantee.
    expect(await screen.findByText(/Excluding itself deletes nothing/)).toBeInTheDocument()
    expect(screen.queryByText(/already recorded stay/)).not.toBeInTheDocument()
    // Restore clears the flag — it does not put the values back.
    expect(screen.getByText(/Restore puts the variable back in scans/)).toBeInTheDocument()
  })

  it('names the contexts and drifts a delete destroys, not just the field text', async () => {
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'variant',
        source_name: 'payload.variant',
        context_count: 3,
        open_drift_count: 1,
      }),
    ])

    renderVariablesTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete variable variant' }))

    // Both counts ride along on the list row, so saying this costs no request —
    // and they are the part of a delete a reader cannot rebuild afterwards.
    expect(
      await screen.findByText(/Its 3 value contexts and 1 open drift go with it/),
    ).toBeInTheDocument()
  })

  it('agrees the verb with a single doomed record', async () => {
    mockList([
      makeVariable({
        id: 'var-1',
        name: 'variant',
        source_name: 'payload.variant',
        context_count: 0,
        open_drift_count: 1,
      }),
    ])

    renderVariablesTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete variable variant' }))

    expect(await screen.findByText(/Its 1 open drift goes with it/)).toBeInTheDocument()
  })

  it('drops the "use Exclude instead" advice for a variable already excluded', async () => {
    mockList([
      makeVariable({
        id: 'var-2',
        name: 'old_junk',
        source_name: 'old.junk',
        excluded_from_scans: true,
      }),
    ])

    renderVariablesTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Delete variable old_junk' }))

    // The reader took that route already. What they cannot see is that the
    // exclusion is a column on the row they are deleting.
    expect(await screen.findByText(/re-create it, un-excluded/)).toBeInTheDocument()
    expect(screen.queryByText(/use Exclude to keep it out/)).not.toBeInTheDocument()
  })
})
