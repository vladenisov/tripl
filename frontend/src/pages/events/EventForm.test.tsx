import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { Event as TEvent, EventType, Project, Variable } from '@/types'
import { eventsApi } from '@/api/events'
import { scansApi } from '@/api/scans'
import { DemoScenarioProvider } from '@/demo/DemoScenarioProvider'
import { readScenarioState, writeScenarioState } from '@/demo/scenarioModel'
import { chapterState } from '@/demo/scenarioTestState'
import { EventForm } from './EventForm'

vi.mock('@/api/events', () => ({
  eventsApi: {
    create: vi.fn(),
    update: vi.fn(),
    // The form probes the catalog for an event already holding the scan
    // identity it is about to claim. Defaulting to "nothing found" keeps every
    // other test on the path where the probe answers and finds no clash —
    // leaving it off the mock would make the query throw, and the tests would
    // pass for the wrong reason.
    list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  },
}))

vi.mock('@/api/scans', () => ({
  scansApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}))

// useAiStatus fires aiApi.status under the hood; stub it so no real request runs.
vi.mock('@/api/ai', () => ({
  aiApi: {
    status: vi.fn().mockResolvedValue({ enabled: false }),
    describeEvent: vi.fn(),
  },
}))

// Minimal fixtures: the event type has no field definitions so the form renders
// only the Details card (no FieldValueControl / MetaFieldControl branches).
const EVENT_TYPE = {
  id: 'et-1',
  name: 'checkout',
  display_name: 'Checkout',
  field_definitions: [],
} as unknown as EventType

const EXISTING_EVENT = {
  id: 'ev-1',
  event_type_id: 'et-1',
  name: 'checkout:completed',
  description: '',
  status: 'draft',
  sunset_at: null,
  metric_breakdown_columns: [],
  tags: [],
  field_values: [],
  meta_values: [],
} as unknown as TEvent

const TEMPLATE_EVENT_TYPE = {
  ...EVENT_TYPE,
  field_definitions: [
    {
      id: 'field-variant',
      event_type_id: 'et-1',
      name: 'variant',
      display_name: 'Variant',
      field_type: 'string',
      is_required: false,
      enum_options: null,
      order: 0,
    },
  ],
} as unknown as EventType

const JSON_TEMPLATE_EVENT_TYPE = {
  ...TEMPLATE_EVENT_TYPE,
  field_definitions: [
    ...TEMPLATE_EVENT_TYPE.field_definitions,
    {
      id: 'field-payload',
      event_type_id: 'et-1',
      name: 'payload',
      display_name: 'Payload',
      field_type: 'json',
      is_required: false,
      enum_options: null,
      order: 1,
    },
  ],
} as unknown as EventType

const JSON_PRODUCT_ID_EVENT_TYPE = {
  ...EVENT_TYPE,
  field_definitions: [
    {
      id: 'field-json-product-id',
      event_type_id: 'et-1',
      name: 'product_id',
      display_name: 'Product ID',
      field_type: 'json',
      is_required: false,
      enum_options: null,
      order: 0,
    },
  ],
} as unknown as EventType

const TEMPLATE_VARIABLE: Variable = {
  id: 'var-1',
  project_id: 'project-1',
  name: 'variant',
  source_name: 'legacy.variant',
  variable_type: 'string',
  description: 'Experiment variant',
  allowed_values: ['control', 'treatment', 'holdout', 'overflow'],
  bindings: ['payload.variant'],
}

const EDIT_EVENT_TYPE = {
  ...EVENT_TYPE,
  name: 'purchase',
  display_name: 'Purchase',
  field_definitions: [
    {
      id: 'field-product-id',
      event_type_id: 'et-1',
      name: 'product_id',
      display_name: 'Product ID',
      field_type: 'string',
      is_required: false,
      enum_options: null,
      order: 0,
    },
  ],
} as unknown as EventType

const EDIT_EVENT = {
  ...EXISTING_EVENT,
  name: 'Trial Started',
  field_values: [{ field_definition_id: 'field-product-id', value: '${product_id}' }],
} as unknown as TEvent

const PRODUCT_ID_VARIABLE: Variable = {
  id: 'var-product-id',
  project_id: 'project-1',
  name: 'product_id',
  source_name: 'product_id',
  variable_type: 'string',
  description: 'Store product / SKU identifier.',
  allowed_values: [],
  bindings: [],
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  // The form links out — to the existing event holding a claimed scan identity,
  // and to event-type creation on an empty project — so it needs a router.
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MemoryRouter, null, children),
  )
}

function renderForm(
  event: TEvent | null,
  {
    eventTypes = [EVENT_TYPE],
    projectVariables = [] as Variable[],
  }: {
    eventTypes?: EventType[]
    projectVariables?: Variable[]
  } = {},
) {
  return render(
    createElement(EventForm, {
      slug: 'demo',
      eventTypes,
      metaFields: [],
      projectVariables,
      event,
      onClose: () => {},
    }),
    { wrapper },
  )
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  queryClient.clear()
  vi.clearAllMocks()
})

describe('EventForm event-type field', () => {
  it('disables the event-type select and shows the immutability helper when editing', () => {
    renderForm(EXISTING_EVENT)

    expect(screen.getByLabelText('Event type', { exact: false })).toBeDisabled()
    expect(screen.getByText("Can't be changed after creation.")).toBeInTheDocument()
  })

  it('keeps the event-type select editable with no helper when creating', () => {
    renderForm(null)

    expect(screen.getByLabelText('Event type', { exact: false })).toBeEnabled()
    expect(screen.queryByText("Can't be changed after creation.")).not.toBeInTheDocument()
  })
})

describe('EventForm name field', () => {
  it('uses a colon-delimited example for the Name placeholder', () => {
    renderForm(null)

    const nameInput = screen.getByPlaceholderText(/checkout:completed/)
    expect(nameInput).toBeInTheDocument()
    // Colon-delimited convention, not snake_case (see ReconciliationPage naming).
    expect(nameInput.getAttribute('placeholder')).not.toMatch(/_/)
  })
})

describe('EventForm template authoring', () => {
  it('does not constrain an uncoached JSON field merely because it is named product_id', () => {
    renderForm(null, { eventTypes: [JSON_PRODUCT_ID_EVENT_TYPE] })

    expect(
      screen.getByLabelText('Product ID').closest('[class~="max-w-[320px]"]'),
    ).toBeNull()
  })

  it('shows rich ${ suggestions, inline unknown-token warnings, and copyable documented values', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderForm(null, {
      eventTypes: [TEMPLATE_EVENT_TYPE],
      projectVariables: [TEMPLATE_VARIABLE],
    })

    const input = screen.getByLabelText('Variant')
    fireEvent.change(input, { target: { value: '${' } })

    const selectedSuggestion = screen.getByRole('option', { name: /\$\{variant\}/ })
    expect(selectedSuggestion).toBeInTheDocument()
    expect(within(selectedSuggestion).getByText('${variant}')).toHaveClass(
      'text-accent-foreground',
    )
    const description = within(selectedSuggestion).getByText('Experiment variant')
    expect(description.parentElement).toHaveClass('min-w-0', 'flex-1', 'overflow-hidden')
    expect(description).toHaveClass('w-full', 'truncate', 'text-accent-foreground/80')
    expect(within(selectedSuggestion).getByText('payload.variant')).toHaveClass(
      'w-full',
      'truncate',
    )
    expect(within(selectedSuggestion).getByText('control · treatment · holdout')).toHaveClass(
      'w-full',
      'truncate',
    )

    fireEvent.change(input, { target: { value: '${missing}' } })
    expect(screen.getByText('Unknown variable token: ${missing}')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '${variant}' } })
    const copyChip = screen.getByRole('button', { name: 'Copy documented value control' })
    fireEvent.click(copyChip)
    expect(writeText).toHaveBeenCalledWith('control')
    expect(screen.getByText('Copied control')).toBeInTheDocument()
    expect(input).toHaveValue('${variant}')
  })
})

describe('EventForm scan-rule generated names', () => {
  it('locks the name input and previews the template-generated name', async () => {
    vi.mocked(scansApi.list).mockResolvedValue([
      {
        id: 'scan-1',
        event_type_id: 'et-1',
        event_name_format: 'pv:{variant}',
      } as never,
    ])

    renderForm(null, {
      eventTypes: [TEMPLATE_EVENT_TYPE],
      projectVariables: [],
    })

    const nameInput = (await screen.findByLabelText(/Name/)) as HTMLInputElement
    await screen.findByText(/generated by scan rule/)
    // readOnly, not disabled: the generated name has to stay selectable and
    // copyable, and a disabled input is skipped by constraint validation so its
    // `required` mark would promise a check nothing runs (tripl-u2h9.5).
    expect(nameInput).toHaveAttribute('readonly')
    expect(nameInput).not.toBeDisabled()
    // Unresolved template key is called out and blocks submit. It names the row
    // on screen ("Variant"), not the raw warehouse column ("variant") the
    // reader would have had to map it onto (tripl-u2h9.4).
    expect(screen.getByText(/Fill field values for: Variant/)).toBeInTheDocument()
    expect(nameInput.value).toBe('pv:{variant}')

    // "Variant*", not "Variant": a column the name is built from is required in
    // practice, so the row carries the mark and the control carries the
    // attribute (tripl-u2h9.4).
    fireEvent.change(screen.getByLabelText(/^Variant/), { target: { value: 'b2' } })
    expect(nameInput.value).toBe('pv:b2')
    expect(screen.queryByText(/Fill field values for/)).not.toBeInTheDocument()
  })

  it('uses the type-specific scan rule instead of a project-wide fallback', async () => {
    vi.mocked(scansApi.list).mockResolvedValue([
      {
        id: 'scan-generic',
        event_type_id: null,
        event_name_format: 'generic:{variant}',
        updated_at: '2026-01-02T00:00:00Z',
      } as never,
      {
        id: 'scan-exact-old',
        event_type_id: 'et-1',
        event_name_format: 'old:{variant}',
        updated_at: '2026-01-01T00:00:00Z',
      } as never,
      {
        id: 'scan-exact-new',
        event_type_id: 'et-1',
        event_name_format: 'exact:{variant}',
        updated_at: '2026-01-03T00:00:00Z',
      } as never,
    ])

    renderForm(null, { eventTypes: [TEMPLATE_EVENT_TYPE] })

    await screen.findByText(/generated by scan rule: exact:\{variant\}/)
    fireEvent.change(screen.getByLabelText(/^Variant/), { target: { value: 'b2' } })
    expect(screen.getByLabelText(/Name/)).toHaveValue('exact:b2')
  })
})

describe('EventForm — authoring an event the scan will recognise', () => {
  const RULED_SCANS = [
    {
      id: 'scan-1',
      event_type_id: 'et-1',
      event_name_format: 'pv:{variant}',
      metric_breakdown_columns: ['country'],
      platform_column: 'platform',
      app_version_column: null,
      updated_at: '2026-01-01T00:00:00Z',
    } as never,
  ]

  it('marks the rows the name is built from, and says so on the card', async () => {
    vi.mocked(scansApi.list).mockResolvedValue(RULED_SCANS)
    renderForm(null, { eventTypes: [JSON_TEMPLATE_EVENT_TYPE] })

    await screen.findByText(/generated by scan rule/)
    // The naming column is called out; the one that plays no part in the name
    // is not. Before this the reader had six unmarked rows and a warning naming
    // raw warehouse columns (tripl-u2h9.4).
    expect(screen.getByText(/The event name is built from variant/)).toBeInTheDocument()
    expect(screen.getAllByText('names the event')).toHaveLength(1)
    expect(screen.getByLabelText(/^Variant/)).toBeRequired()
    expect(screen.getByLabelText('Payload')).not.toBeRequired()
  })

  it('offers no name example while the rule writes the box', async () => {
    vi.mocked(scansApi.list).mockResolvedValue(RULED_SCANS)
    renderForm(null, { eventTypes: [TEMPLATE_EVENT_TYPE] })

    await screen.findByText(/generated by scan rule/)
    // "e.g. checkout:completed" advertises free text on a control that has none
    // (tripl-u2h9.9).
    expect(screen.getByLabelText(/Name/)).not.toHaveAttribute('placeholder')
  })

  it('says a name typed before the type was chosen is not used', async () => {
    vi.mocked(scansApi.list).mockResolvedValue(RULED_SCANS)
    // Two types, so none is preselected and the Name box starts editable —
    // exactly the order in which a user meets this: type a name, then choose.
    const OTHER_TYPE = { ...EVENT_TYPE, id: 'et-2', display_name: 'Other' } as EventType
    renderForm(null, { eventTypes: [OTHER_TYPE, TEMPLATE_EVENT_TYPE] })

    const nameInput = screen.getByLabelText(/Name/)
    expect(nameInput).not.toHaveAttribute('readonly')
    fireEvent.change(nameInput, { target: { value: 'my crooked name' } })
    fireEvent.change(screen.getByLabelText(/Event type/), { target: { value: 'et-1' } })

    // The typed name survives in state and would return on a type with no rule,
    // so it must be accounted for rather than left to vanish (tripl-u2h9.7).
    expect(await screen.findByText(/“my crooked name” is not used/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Name/)).toHaveValue('pv:{variant}')
  })

  it('refuses a name an existing event already answers to', async () => {
    vi.mocked(scansApi.list).mockResolvedValue(RULED_SCANS)
    vi.mocked(eventsApi.list).mockResolvedValue({
      items: [{ id: 'ev-existing', name: 'pv:b2' }],
      total: 1,
    } as never)
    renderForm(null, { eventTypes: [TEMPLATE_EVENT_TYPE] })

    await screen.findByText(/generated by scan rule/)
    fireEvent.change(screen.getByLabelText(/^Variant/), { target: { value: 'b2' } })

    const warning = await screen.findByRole('alert')
    expect(warning).toHaveTextContent(/already answers to this name/)
    expect(within(warning).getByRole('link', { name: /open it instead/i })).toHaveAttribute(
      'href',
      '/p/demo/monitoring/event/ev-existing',
    )
    expect(screen.getByRole('button', { name: /Create event/i })).toBeDisabled()
  })

  it('offers the type schema and the scans, not four hardcoded columns', async () => {
    vi.mocked(scansApi.list).mockResolvedValue(RULED_SCANS)
    renderForm(null, { eventTypes: [JSON_TEMPLATE_EVENT_TYPE] })

    await screen.findByText(/generated by scan rule/)
    // What the docs describe and the redesign dropped: the type's scalar fields,
    // JSON excluded, plus the columns the scans actually collect. 'device_model'
    // was one of the four literals and belongs to neither (tripl-u2h9.6).
    expect(screen.getByRole('button', { name: 'variant' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'payload' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'country' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'platform' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'device_model' })).not.toBeInTheDocument()
  })

  it('still takes a column no schema or scan knows about', async () => {
    vi.mocked(scansApi.list).mockResolvedValue([])
    renderForm(null, { eventTypes: [TEMPLATE_EVENT_TYPE] })

    const input = await screen.findByLabelText(/Metric breakdowns/)
    fireEvent.change(input, { target: { value: 'device_model' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByRole('button', { name: 'device_model' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('sends a project with no event types somewhere instead of nowhere', async () => {
    vi.mocked(scansApi.list).mockResolvedValue([])
    renderForm(null, { eventTypes: [] })

    // The select offered "Select type…" and nothing else, on the first screen a
    // new project reaches (tripl-u2h9.3).
    expect(await screen.findByText(/This project has no event types yet/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Create an event type/i })).toHaveAttribute(
      'href',
      '/p/demo/settings/event-types',
    )
    expect(screen.queryByRole('combobox', { name: /Event type/ })).not.toBeInTheDocument()
  })
})

describe('EventForm save and add another', () => {
  it('creates the event without closing or clearing entered values', async () => {
    vi.mocked(eventsApi.create).mockResolvedValue({} as never)
    vi.mocked(scansApi.list).mockResolvedValue([])
    const onClose = vi.fn()
    render(
      createElement(EventForm, {
        slug: 'demo',
        eventTypes: [JSON_TEMPLATE_EVENT_TYPE],
        metaFields: [],
        projectVariables: [],
        event: null,
        onClose,
      }),
      { wrapper },
    )

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'checkout:started' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Starts checkout.' } })
    fireEvent.change(screen.getByLabelText('Variant'), { target: { value: 'b2' } })
    fireEvent.change(screen.getByLabelText('Payload'), { target: { value: '{"source":"cta"}' } })
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'critical' } })
    fireEvent.keyDown(screen.getByLabelText('Tags'), { key: 'Enter' })

    fireEvent.click(screen.getByRole('button', { name: /Save and add another/i }))

    await waitFor(() =>
      expect(eventsApi.create).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({
          name: 'checkout:started',
          description: 'Starts checkout.',
          tags: ['critical'],
          field_values: [
            { field_definition_id: 'field-variant', value: 'b2' },
            { field_definition_id: 'field-payload', value: '{"source":"cta"}' },
          ],
        }),
        null,
      ),
    )
    expect(onClose).not.toHaveBeenCalled()
    // Retention is the point of this button, and documented as such in
    // website/docs/use/feature-reference.md — a run of similar events is
    // authored by changing one field between saves. Do not "fix" it by
    // resetting the form.
    expect(screen.getByLabelText(/Name/)).toHaveValue('checkout:started')
    expect(screen.getByLabelText('Description')).toHaveValue('Starts checkout.')
    expect(screen.getByLabelText('Variant')).toHaveValue('b2')
    expect(screen.getByLabelText('Payload')).toHaveValue('{"source":"cta"}')
    expect(screen.getByText('critical')).toBeInTheDocument()
  })

  it('says what it created, and stops saying it once the form describes another event', async () => {
    vi.mocked(eventsApi.create).mockResolvedValue({ name: 'checkout:started' } as never)
    vi.mocked(scansApi.list).mockResolvedValue([])
    render(
      createElement(EventForm, {
        slug: 'demo',
        eventTypes: [JSON_TEMPLATE_EVENT_TYPE],
        metaFields: [],
        projectVariables: [],
        event: null,
        onClose: vi.fn(),
      }),
      { wrapper },
    )

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'checkout:started' } })
    fireEvent.click(screen.getByRole('button', { name: /Save and add another/i }))

    // Without this the form looked untouched after a save, which is why a
    // second press read as the obvious next action (tripl-u2h9.2).
    const created = await screen.findByRole('status')
    expect(created).toHaveTextContent('Created checkout:started')

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'checkout:completed' } })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('EventForm — coached demo scenario (tripl-odrj.4)', () => {
  const SLUG = 'demo'

  const demoProject = {
    id: 'p-1',
    name: 'Demo',
    slug: SLUG,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    is_demo: true,
    generation_status: 'ready',
  } as unknown as Project

  function renderCoachedEditEvent(event: TEvent = EDIT_EVENT) {
    return render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: [`/p/${SLUG}/events/purchase/ev-1/edit`] },
          createElement(
            DemoScenarioProvider,
            { project: demoProject, pollIntervalMs: 10_000, children: null },
            createElement(EventForm, {
              slug: SLUG,
              eventTypes: [EDIT_EVENT_TYPE],
              metaFields: [],
              projectVariables: [PRODUCT_ID_VARIABLE],
              event,
              onClose: () => {},
            }),
          ),
        ),
      ),
    )
  }

  afterEach(() => {
    window.localStorage.clear()
  })

  it('coaches a documented Product ID and then restores the seeded variable token', async () => {
    writeScenarioState(SLUG, chapterState('edit-event', 'edit-event/set-value'))

    renderCoachedEditEvent()

    const productId = screen.getByLabelText('Product ID')
    expect(productId).toHaveAttribute('role', 'combobox')
    expect(productId).toHaveValue('${product_id}')
    const coachTarget = productId.closest('[data-coach-target="edit-event/set-value"]')
    expect(coachTarget).not.toBeNull()
    expect(coachTarget).toHaveClass('max-w-[320px]')
    expect(coachTarget).toContainElement(productId)
    expect(
      screen.getByText(
        'Replace the current Product ID value with prod_monthly. The guide advances automatically — do not save yet.',
      ),
    ).toBeInTheDocument()
    fireEvent.change(productId, { target: { value: 'prod_monthly' } })

    await waitFor(() =>
      expect(readScenarioState(SLUG).chapters['edit-event']?.step).toBe('edit-event/set-token'),
    )
    expect(
      screen.getByText(
        'Replace prod_monthly: type $ in Product ID, choose ${product_id}, then follow the guide to Save.',
      ),
    ).toBeInTheDocument()

    fireEvent.change(productId, { target: { value: '$' } })
    fireEvent.mouseDown(screen.getByRole('option', { name: /\$\{product_id\}/ }))

    await waitFor(() => {
      expect(readScenarioState(SLUG).chapters['edit-event']?.step).toBe('edit-event/save')
      expect(screen.getByLabelText('Product ID')).toHaveValue('${product_id}')
    })
    expect(screen.getByText('Save the event — the tracking plan updates immediately.')).toBeInTheDocument()
  })

  it('catches up when the rendered Product ID already satisfies the active step', async () => {
    writeScenarioState(SLUG, chapterState('edit-event', 'edit-event/set-value'))
    renderCoachedEditEvent({
      ...EDIT_EVENT,
      field_values: [{ field_definition_id: 'field-product-id', value: 'prod_monthly' }],
    } as TEvent)

    await waitFor(() =>
      expect(readScenarioState(SLUG).chapters['edit-event']?.step).toBe('edit-event/set-token'),
    )
    expect(screen.getByText(/type \$ in Product ID/)).toBeInTheDocument()
  })

  it("completes the edit-event chapter's save step through the real save mutation", async () => {
    writeScenarioState(SLUG, chapterState('edit-event', 'edit-event/save'))
    vi.mocked(eventsApi.update).mockResolvedValue({} as never)

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: [`/p/${SLUG}/events/all/ev-1/edit`] },
          createElement(
            DemoScenarioProvider,
            { project: demoProject, pollIntervalMs: 10_000, children: null },
            createElement(EventForm, {
              slug: SLUG,
              eventTypes: [EVENT_TYPE],
              metaFields: [],
              projectVariables: [],
              event: EXISTING_EVENT,
              onClose: () => {},
            }),
          ),
        ),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: /Save event/i }))

    await waitFor(() =>
      expect(readScenarioState(SLUG).chapters['edit-event']?.status).toBe('completed'),
    )
  })
})
