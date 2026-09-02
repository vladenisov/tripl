import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BranchContext } from '@/components/branch-context-internal'
import { eventsApi } from '@/api/events'
import { variablesApi } from '@/api/variables'
import { variableDriftsApi } from '@/api/variableDrifts'
import { variableOverridesApi } from '@/api/variableOverrides'
import { formatDateTime } from '@/lib/datetime'
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

/** Mounts the tab inside a BranchContext the way the app does, and hands back a
 * `switchBranch` that writes it the way the sidebar's BranchSwitcher does —
 * without remounting the tab, which is the whole point: the switcher is mounted
 * permanently beside this page and a selection outlives its click. */
function renderInBranch(branchId: string | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const tree = (activeBranchId: string | null) => (
    <QueryClientProvider client={queryClient}>
      <BranchContext.Provider
        value={{ branchId: activeBranchId, setBranchId: () => {}, slug: 'demo' }}
      >
        <VariablesTab slug="demo" />
      </BranchContext.Provider>
    </QueryClientProvider>
  )
  const view = render(tree(branchId))
  return { ...view, switchBranch: (next: string | null) => view.rerender(tree(next)) }
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

  it('searches the override roster server-side instead of taking the endpoint default (tripl-46am)', async () => {
    // The picker used to fetch the roster with `params` literally undefined, so
    // no limit was emitted and the endpoint's own default of 200 applied. On a
    // project with more events than that the dropdown listed the first 200 in
    // catalog order — no search, no note, and no other route to an override:
    // "Accept for this event" only reaches events that already carry a drift.
    mockList([makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a'] })])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableOverridesApi.list).mockResolvedValue([])
    vi.mocked(variableDriftsApi.list).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(eventsApi.list).mockResolvedValue({
      items: Array.from({ length: 100 }, (_, index) => ({
        id: `ev-${index}`,
        name: `Event ${index}`,
      })) as never,
      total: 4000,
    })

    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit variable variant' }))

    // A limit this page chose, not one it inherited without knowing.
    await waitFor(() =>
      expect(eventsApi.list).toHaveBeenCalledWith(
        'demo',
        { search: undefined, limit: 100, offset: 0 },
        null,
      ),
    )

    // And it says what it did NOT show — the same honesty the variables table
    // directly above already practises for its own truncation.
    expect(await screen.findByText(/3900 more not listed/)).toBeInTheDocument()

    // Typing reaches the rest of the catalog through the server's own ILIKE
    // over name/description/source_name, so no event is unreachable.
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'payment' } })
    await waitFor(() =>
      expect(eventsApi.list).toHaveBeenCalledWith(
        'demo',
        { search: 'payment', limit: 100, offset: 0 },
        null,
      ),
    )
  })

  it('shows the event of an override that sits outside the loaded roster (tripl-46am)', async () => {
    mockList([makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a'] })])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableDriftsApi.list).mockResolvedValue({ items: [], total: 0 })
    // The override's event is NOT in the page the picker loaded. Its name still
    // arrives on the overrides response, so the row renders — but the Edit
    // pencil set an id no <option> carried and the select painted BLANK while
    // Save stayed enabled, letting someone overwrite an override without ever
    // seeing which event they were editing.
    vi.mocked(variableOverridesApi.list).mockResolvedValue([
      {
        id: 'ovr-1',
        variable_id: 'var-1',
        event_id: 'ev-far',
        event_name: 'Checkout Completed',
        values: ['x'],
      },
    ])
    vi.mocked(eventsApi.list).mockResolvedValue({
      items: [{ id: 'ev-1', name: 'Onboarding' }] as never,
      total: 3000,
    })
    vi.mocked(variableOverridesApi.upsert).mockResolvedValue({
      id: 'ovr-1',
      variable_id: 'var-1',
      event_id: 'ev-far',
      event_name: 'Checkout Completed',
      values: ['x'],
    })

    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit variable variant' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Edit override for Checkout Completed' }),
    )

    const select = screen.getByLabelText('Override event') as HTMLSelectElement
    expect(select.value).toBe('ev-far')
    expect(within(select).getByRole('option', { name: 'Checkout Completed' })).toBeInTheDocument()

    // And the save still targets that event, not the roster row above it.
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))
    await waitFor(() =>
      expect(variableOverridesApi.upsert).toHaveBeenCalledWith('demo', 'var-1', 'ev-far', ['x'], null),
    )
  })

  it('drops the selection when the filter text changes, not only on the usage filter (tripl-42en)', async () => {
    mockList([
      makeVariable({ id: 'var-1', name: 'checkout_step' }),
      makeVariable({ id: 'var-2', name: 'checkout_total' }),
      makeVariable({ id: 'var-3', name: 'checkout_coupon' }),
      makeVariable({ id: 'var-4', name: 'payment_method' }),
    ])
    vi.mocked(variablesApi.bulkUpdate).mockResolvedValue(undefined)

    renderVariablesTab()
    await screen.findByText('${checkout_step}')

    fireEvent.change(screen.getByLabelText('Filter variables'), { target: { value: 'checkout' } })
    fireEvent.click(screen.getByLabelText('Select all variables'))

    // Positive control: the bar is up, holding the three checkout rows.
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter variables'), { target: { value: 'payment' } })

    // Selection spans every MATCHING row rather than the page on screen, so the
    // three checkout ids used to survive a filter that hid them: the table
    // showed only payment rows, all unticked, and the bar still said "3
    // selected". Delete confirmed with a bare count and destroyed three
    // variables nobody could see or name, cascading their value contexts and
    // drifts — the ids were still loaded client-side, so nothing 404'd and no
    // toast fired. Set type, Set description and Add values hit the same rows.
    expect(await screen.findByText('${payment_method}')).toBeInTheDocument()
    expect(screen.queryByLabelText('Clear selection')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Bulk set type')).not.toBeInTheDocument()

    // The guard the usage filter already carried, now shared by both controls
    // rather than copy-pasted onto one of them.
    fireEvent.change(screen.getByLabelText('Filter variables'), { target: { value: '' } })
    fireEvent.click(await screen.findByLabelText('Select all variables'))
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Unused' }))
    expect(screen.queryByLabelText('Clear selection')).not.toBeInTheDocument()
  })

  /** Three rows and a full selection, for the row-level actions that move ONE of
   * them out of the match set. The list mock deliberately keeps returning all
   * three unchanged, so nothing but the one-id removal can move the count — a
   * prune against the refetched rows would find every id still matching. */
  function selectAllOfThree() {
    mockList([
      makeVariable({ id: 'var-1', name: 'checkout_step', source_name: 'checkout.step' }),
      makeVariable({ id: 'var-2', name: 'checkout_total', source_name: 'checkout.total' }),
      makeVariable({ id: 'var-3', name: 'checkout_coupon', source_name: 'checkout.coupon' }),
    ])
  }

  it('drops only the excluded row from the selection, keeping the rest of the batch (tripl-42en)', async () => {
    selectAllOfThree()
    vi.mocked(variablesApi.update).mockResolvedValue({} as never)
    vi.mocked(variablesApi.bulkUpdate).mockResolvedValue(undefined)

    renderVariablesTab()
    fireEvent.click(await screen.findByLabelText('Select all variables'))
    expect(screen.getByText('3')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Exclude variable checkout_total from scans' }),
    )
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Exclude' }),
    )
    await waitFor(() => expect(variablesApi.update).toHaveBeenCalled())

    // Excluding moves the row out of the table and into the panel below it. Its
    // id used to stay ticked, so the bar still said 3 and a bulk Delete took the
    // tombstone with the rest — which un-excludes the name, because the flag is
    // a column on the row being deleted, and hands it straight back to the next
    // scan.
    expect(await screen.findByText('2')).toBeInTheDocument()

    // ONLY that id. Exclude is a one-row action and does not route through
    // changeMatchSet, which would clear the whole batch and jump to page 0.
    fireEvent.change(screen.getByLabelText('Bulk set type'), { target: { value: 'number' } })
    await waitFor(() =>
      expect(variablesApi.bulkUpdate).toHaveBeenCalledWith(
        'demo',
        { variable_ids: ['var-1', 'var-3'], variable_type: 'number' },
        null,
      ),
    )
  })

  it('drops a singly-deleted row from the selection before the next bulk confirm (tripl-42en)', async () => {
    selectAllOfThree()
    vi.mocked(variablesApi.del).mockResolvedValue(undefined)
    vi.mocked(variablesApi.bulkDelete).mockResolvedValue(undefined)

    renderVariablesTab()
    fireEvent.click(await screen.findByLabelText('Select all variables'))

    fireEvent.click(screen.getByRole('button', { name: 'Delete variable checkout_total' }))
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    )
    await waitFor(() => expect(variablesApi.del).toHaveBeenCalledWith('demo', 'var-2', null))

    // A stale id inflates the next confirm — "Delete 3 selected variables?" over
    // two rows — and then takes the bulk call down with it: the service raises
    // 404 for the whole batch on the first id it cannot load.
    expect(await screen.findByText('2')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(
      await screen.findByText(/Delete 2 selected variables\?/),
    ).toBeInTheDocument()
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    )
    await waitFor(() =>
      expect(variablesApi.bulkDelete).toHaveBeenCalledWith('demo', ['var-1', 'var-3'], null),
    )
  })

  it('clears the selection when the sidebar switches branch (tripl-42en)', async () => {
    // The fixture returns the same rows on both branches ON PURPOSE, so the
    // assertion isolates the branch guard: a prune against the refetched list
    // would find every selected id still matching and leave the bar up. A branch
    // switch has to clear regardless of what the branch it lands on happens to
    // hold — the ids are scoped to the branch they were picked on, and
    // `_load_variables_by_ids` 404s the whole bulk call on the first one the new
    // branch cannot show.
    selectAllOfThree()

    const { switchBranch } = renderInBranch(null)
    fireEvent.click(await screen.findByLabelText('Select all variables'))
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument()

    switchBranch('branch-9')

    expect(screen.queryByLabelText('Clear selection')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Bulk set type')).not.toBeInTheDocument()
    // The rows on screen really are the other branch's now.
    await waitFor(() =>
      expect(variablesApi.listPage).toHaveBeenCalledWith('demo', 'branch-9', { usage: 'all' }),
    )
  })

  it('prunes a selection its own bulk update moved out of the usage filter (tripl-42en)', async () => {
    // "Unused" is answered SERVER-side by the retirement predicate, which keeps
    // any row carrying documented values. Adding values to every selected row is
    // therefore the edit that empties this filter's own list — the mock moves
    // with the mutation the way the backend would.
    let listed = [
      makeVariable({ id: 'var-1', name: 'legacy_a' }),
      makeVariable({ id: 'var-2', name: 'legacy_b' }),
    ]
    vi.mocked(variablesApi.listPage).mockImplementation(async () => ({
      items: listed,
      total: listed.length,
    }))
    vi.mocked(variablesApi.bulkUpdate).mockImplementation(async () => {
      listed = []
    })

    renderVariablesTab()
    await screen.findByText('${legacy_a}')

    fireEvent.click(screen.getByRole('button', { name: 'Unused' }))
    fireEvent.click(await screen.findByLabelText('Select all variables'))
    expect(screen.getByText('2')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Bulk add values'), { target: { value: 'a, b' } })
    fireEvent.keyDown(screen.getByLabelText('Bulk add values'), { key: 'Enter' })
    await waitFor(() => expect(variablesApi.bulkUpdate).toHaveBeenCalled())

    // No control moved the boundary here — the operator's own edit did, and
    // nothing announced it. The bar was left floating "2 selected", with a
    // Delete button, over the empty state, one click from destroying the two
    // variables that had just been documented.
    expect(await screen.findByText('Nothing to retire')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByLabelText('Clear selection')).not.toBeInTheDocument(),
    )
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('lets Enter search events without submitting the edit form (tripl-46am)', async () => {
    mockList([makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a'] })])
    vi.mocked(variablesApi.values).mockResolvedValue([])
    vi.mocked(variableOverridesApi.list).mockResolvedValue([])
    vi.mocked(variableDriftsApi.list).mockResolvedValue({ items: [], total: 0 })
    vi.mocked(eventsApi.list).mockResolvedValue({ items: [] as never, total: 0 })
    vi.mocked(variablesApi.update).mockResolvedValue({} as never)

    renderVariablesTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Edit variable variant' }))

    const search = await screen.findByLabelText('Search events')
    fireEvent.change(search, { target: { value: 'checkout' } })

    // The box sits inside the edit dialog's <form>, one type="submit" Save away
    // from HTML implicit submission, so Enter — the universal gesture in a
    // search field — PATCHed the variable with whatever the fields above held
    // and closed the dialog on the override being written. jsdom does not
    // implement implicit submission, so the observable that stands in for it is
    // the default action of the keystroke itself: preventing it is exactly what
    // stops the browser reaching the submit, and it is what ChipListInput
    // already does inside this same form.
    const enter = createEvent.keyDown(search, { key: 'Enter' })
    fireEvent(search, enter)
    expect(enter.defaultPrevented).toBe(true)

    // Nothing runs in its place — the search is debounced and applies as you
    // type — and the dialog is still open with the edit intact.
    expect(variablesApi.update).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Search events')).toHaveValue('checkout')

    // Save still submits: the guard is on the keystroke, not on the form.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(variablesApi.update).toHaveBeenCalled())
  })

  it('reads a future-snoozed drift the way the badge counts it (tripl-lh61)', async () => {
    // `open_drift_count` is `get_open_drift_counts`, and its predicate drops a
    // snooze whose time has not come — so the row carries NO badge. The dialog
    // used to disagree with the table beside it: same drift, warning tone, full
    // Accept / Snooze / False positive row, and a "Show N resolved" toggle that
    // counted only resolutions, so the row could never be collapsed away.
    const snoozedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    mockList([
      makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a'], open_drift_count: 0 }),
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
          status: 'snoozed',
          resolution_note: null,
          snoozed_until: snoozedUntil,
          resolved_at: null,
          resolved_by: null,
          detected_at: '2026-07-09T00:00:00Z',
        },
      ],
      total: 1,
    })
    vi.mocked(variableDriftsApi.action).mockResolvedValue({} as never)

    renderVariablesTab()

    // What the table says: nothing open.
    expect(await screen.findByText('${variant}')).toBeInTheDocument()
    expect(screen.queryByText('1 drift')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Edit variable variant' }))
    await screen.findByText(/value drift — observed values outside/i)

    // The dialog now says the same thing: the row is not on the active list, so
    // the review actions it used to offer are not there.
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Snooze 7d' })).not.toBeInTheDocument()

    // Collapsible at last, and the toggle does not call a snooze a resolution.
    fireEvent.click(await screen.findByRole('button', { name: 'Show 1 snoozed' }))
    expect(
      await screen.findByText(`snoozed until ${formatDateTime(snoozedUntil)}`),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Un-snooze' }))
    await waitFor(() =>
      expect(variableDriftsApi.action).toHaveBeenCalledWith(
        'demo',
        'drift-1',
        { action: 'reopen', scope: undefined, snoozed_until: undefined },
        null,
      ),
    )
  })

  it('lets a snooze lapse in a dialog left open, without a remount (tripl-lh61)', async () => {
    // The dialog's clock was `useState(() => Date.now())`, and a lazy
    // initializer runs once per mount — of the whole tab, which outlives any one
    // dialog by a long way. So a snooze that ran out while the tab sat open kept
    // the row collapsed here, offering only Un-snooze, while the badge in the
    // table behind it — recomputed by the backend on every request — had already
    // counted the drift as open again. Same disagreement as the test above, just
    // arriving through the clock instead of the classification.
    vi.useFakeTimers()
    try {
      const snoozedUntil = new Date(Date.now() + 60_000).toISOString()
      mockList([
        makeVariable({ id: 'var-1', name: 'variant', allowed_values: ['a'], open_drift_count: 0 }),
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
            status: 'snoozed',
            resolution_note: null,
            snoozed_until: snoozedUntil,
            resolved_at: null,
            resolved_by: null,
            detected_at: '2026-07-09T00:00:00Z',
          },
        ],
        total: 1,
      })

      renderVariablesTab()

      // `waitFor` cannot drive vitest's fake clock (it only detects jest's), so
      // the timers are advanced explicitly and the assertions are synchronous.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Edit variable variant' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(screen.getByRole('button', { name: 'Show 1 snoozed' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Snooze 7d' })).not.toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })

      // Nothing was clicked and the dialog was never reopened: only the deadline
      // passed, and the row is back on the active list with its review actions.
      expect(screen.queryByRole('button', { name: 'Show 1 snoozed' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Snooze 7d' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the excluded variable a branch-diff link points at (tripl-acp2)', async () => {
    // `excluded_from_scans` is a tracked plan-diff key, so a diff can carry a
    // "variable X — excluded from scans" row linking here with X's id. X is
    // exactly the variable the table filters out, so `findIndex` returned -1,
    // the page fell back to 0, and the reviewer landed on an unrelated list with
    // nothing marked while X sat unmarked in the panel below.
    const scrollIntoView = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {})
    mockList([
      makeVariable({ id: 'var-1', name: 'still_scanned' }),
      makeVariable({ id: 'var-2', name: 'old_junk', excluded_from_scans: true }),
    ])

    renderVariablesTab({ focusId: 'var-2' })

    const excludedRow = (await screen.findByText('${old_junk}')).closest('li')
    expect(excludedRow).toHaveAttribute('data-focused', 'true')
    // Marked AND reached: the link's whole job is to put the reviewer in front
    // of that row.
    expect(scrollIntoView).toHaveBeenCalled()

    // The unrelated row the reviewer used to land on is left alone.
    expect(screen.getByText('${still_scanned}').closest('tr')).not.toHaveAttribute('data-focused')

    scrollIntoView.mockRestore()
  })
})
