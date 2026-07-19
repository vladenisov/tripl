import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  return createElement(QueryClientProvider, { client: queryClient }, children)
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

    expect(screen.getByRole('option', { name: /\$\{variant\}/ })).toBeInTheDocument()
    expect(screen.getByText('Experiment variant')).toBeInTheDocument()
    expect(screen.getByText('payload.variant')).toBeInTheDocument()
    expect(screen.getByText('control · treatment · holdout')).toBeInTheDocument()

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
    expect(nameInput).toBeDisabled()
    // Unresolved template key is called out and blocks submit.
    expect(screen.getByText(/Fill field values for: variant/)).toBeInTheDocument()
    expect(nameInput.value).toBe('pv:{variant}')

    fireEvent.change(screen.getByLabelText('Variant'), { target: { value: 'b2' } })
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
    fireEvent.change(screen.getByLabelText('Variant'), { target: { value: 'b2' } })
    expect(screen.getByLabelText(/Name/)).toHaveValue('exact:b2')
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
    expect(screen.getByLabelText(/Name/)).toHaveValue('checkout:started')
    expect(screen.getByLabelText('Description')).toHaveValue('Starts checkout.')
    expect(screen.getByLabelText('Variant')).toHaveValue('b2')
    expect(screen.getByLabelText('Payload')).toHaveValue('{"source":"cta"}')
    expect(screen.getByText('critical')).toBeInTheDocument()
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

  afterEach(() => {
    window.localStorage.clear()
  })

  it('coaches a documented Product ID and then restores the seeded variable token', async () => {
    writeScenarioState(SLUG, chapterState('edit-event', 'edit-event/set-value'))

    render(
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
              event: EDIT_EVENT,
              onClose: () => {},
            }),
          ),
        ),
      ),
    )

    const productId = screen.getByLabelText('Product ID')
    expect(productId).toHaveAttribute('role', 'combobox')
    expect(productId).toHaveValue('${product_id}')
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
