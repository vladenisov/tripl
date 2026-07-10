import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event as TEvent, EventType, Variable } from '@/types'
import { scansApi } from '@/api/scans'
import { EventForm } from './EventForm'

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
})
