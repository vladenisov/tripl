import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScanConfig } from '@/types'
import { ScanConfigurationTab, ScanCreatePage } from './ScanConfigForm'

// CodeMirror needs real layout measurement jsdom can't provide; a plain textarea
// keeps the SQL field queryable and the suite deterministic.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
  }) => (
    <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
  ),
}))

vi.mock('@/hooks/useBranch', () => ({
  useActiveBranchId: () => null,
}))

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const dataSource = {
  id: 'ds-1',
  name: 'Web Production',
  db_type: 'clickhouse',
  host: 'h',
  port: 8123,
  database_name: 'analytics',
  username: 'u',
  password_set: true,
  connection_settings: {
    location: null,
    maximum_bytes_billed: null,
    dataset_allowlist: null,
    sslmode: null,
    sslrootcert: null,
    sslcert: null,
    search_path: null,
    sslkey_set: false,
  },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const eventType = { id: 'et-1', display_name: 'Purchase', name: 'purchase' }

// A preview job that is already `completed` when the POST answers, so pollJob
// returns without ever sleeping and the suite stays deterministic.
const previewPayload = {
  columns: [
    { name: 'event_name', type_name: 'String', is_nullable: false },
    { name: 'event_ts', type_name: 'DateTime', is_nullable: false },
  ],
  rows: [{ event_name: 'checkout', event_ts: '2026-01-01T00:00:00Z' }],
  json_columns: [],
}

function setupFetch(eventTypes: unknown[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.includes('/data-sources/') && url.includes('/schema')) {
      return mockJsonResponse({ tables: [] })
    }
    if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
    if (url.includes('/scans/preview')) {
      return mockJsonResponse({
        id: 'preview-job-1',
        status: 'completed',
        started_at: null,
        completed_at: null,
        result_summary: previewPayload,
        error_message: null,
      })
    }
    if (url.includes('/event-types')) return mockJsonResponse(eventTypes)
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderCreatePage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ScanCreatePage slug="demo" onBack={() => {}} />
    </QueryClientProvider>,
  )
}

function renderConfigurationTab(scanConfig: ScanConfig) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ScanConfigurationTab slug="demo" scanConfig={scanConfig} onDeleted={() => {}} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScanFormSections — progressive disclosure', () => {
  // The form asks 22 questions. Eight of them need knowledge of tripl's
  // detection internals that exists nowhere else in the product; they must not
  // be in the user's face before the four plain ones are answered.
  it('keeps the detection-internals fields out of the initial form until their section is opened', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')

    expect(screen.queryByLabelText('Cardinality threshold')).toBeNull()
    expect(screen.queryByLabelText('Row cap per metrics run')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Event names and grouping/ }))
    expect(screen.getByLabelText('Cardinality threshold')).toBeInTheDocument()
  })

  it('shows the four plain questions without opening anything', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')

    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByLabelText('Data source')).toBeInTheDocument()
    expect(screen.getByLabelText('Event type')).toBeInTheDocument()
    expect(screen.getByLabelText('Schedule')).toBeInTheDocument()
  })
})

describe('ScanFormSections — where event names come from', () => {
  // "Event type column" used to live in the collapsed "Event names and grouping"
  // section, under a header telling the user to leave it alone — while the
  // Event type default read "Auto-detect", which detected nothing without it.
  // Where the name comes from is ONE question, so it is asked in one place.
  it('asks for the naming column next to Event type, not behind a chevron', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')

    const eventType = screen.getByLabelText('Event type')
    const column = screen.getByLabelText('Event type column')
    expect(column).toBeInTheDocument()
    expect(eventType.compareDocumentPosition(column)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    // And the option that stands for "read it from a column" says so, instead of
    // promising a detection that never happens.
    expect(screen.queryByRole('option', { name: 'Auto-detect' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Name events from a column' })).toBeInTheDocument()
  })

  // The collapsed section's one-line explanation was false on the default path:
  // leaving it alone left the naming column null, and every run of the scan
  // failed. What is left in there really is optional.
  it('no longer promises that leaving the collapsed section alone names anything', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')

    expect(
      screen.queryByText(/Leave this alone and events are named from the column values/),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Event names and grouping/ }))
    expect(screen.getByLabelText('Event name format')).toBeInTheDocument()
  })

  // The whole P0, from the user's side: on the defaults the form let the scan be
  // created, and its first real run failed with a message naming two database
  // fields. The gate is now on the button, and its reason names a control.
  it('refuses to create a scan that cannot name a single event', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main scan' } })
    fireEvent.change(screen.getByLabelText('Data source'), { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByPlaceholderText('SELECT * FROM analytics.events'), {
      target: { value: 'SELECT * FROM analytics.events' },
    })

    const create = screen.getByRole('button', { name: /Create scan/ })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute(
      'title',
      'Pick an Event type, or the Event type column your event names are in.',
    )
    expect(document.body.textContent).not.toMatch(/event_type_id|event_type_column/)
  })

  // Two red flags on an untouched form is how red becomes decoration. The naming
  // column cannot be picked before its options exist, so it is not flagged then.
  it('does not flag the naming column while it is still disabled', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')

    expect(screen.getByLabelText('Event type column')).toBeDisabled()
    expect(screen.queryByText(/without it this scan cannot name a single event/)).toBeNull()
  })
})

describe('ScanFormSections — the answer comes after the questions', () => {
  // The dry run answers for one specific draft, and `toDryRunRequest` carries
  // the time column (the scan window is computed from it). With the panel above
  // the Time column field, the sequence the form itself demands was: load the
  // preview, read the answer, scroll down, pick the time column the form is
  // asking for in red — and watch the answer turn into "The form changed since
  // this check ran, so it no longer describes this scan". Every monitoring scan,
  // every time, until the banner is background noise and no longer protects the
  // case it was written for. So the answer is rendered after everything visible
  // that feeds it.
  it('renders the preview panel after the fields the answer is computed from', async () => {
    setupFetch([eventType])
    renderCreatePage()

    await screen.findByText('New scan')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main scan' } })
    fireEvent.change(screen.getByLabelText('Data source'), { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByPlaceholderText('SELECT * FROM analytics.events'), {
      target: { value: 'SELECT * FROM analytics.events' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Load preview/ }))

    const panel = await screen.findByTestId('scan-preview-panel')

    for (const label of ['Event type', 'Event type column', 'Time column', 'Schedule']) {
      expect(screen.getByLabelText(label).compareDocumentPosition(panel)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
    }
  })

  // The button stays where the query is — it is what brings the column pickers
  // to life, so it cannot wait until after them. Only its answer moves.
  it('keeps Load preview above the pickers it fills', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')
    const button = screen.getByRole('button', { name: /Load preview/ })

    expect(button.compareDocumentPosition(screen.getByLabelText('Time column'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })
})

describe('ScanFormSections — the mode choice', () => {
  it('defaults a new scan to Catalog + monitoring', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')
    expect(screen.getByRole('radio', { name: 'Catalog + monitoring' })).toBeChecked()
  })

  // Catalog only is the absence of a SCHEDULE. Empty is a deliberate answer for
  // both fields there, so nothing is flagged — but the time column is still
  // asked for, because it is also what bounds a run to the lookback window, and
  // hiding it is what let the mode radio destroy a saved one.
  it('drops the schedule in Catalog only, keeps the time column, and says nothing about either', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog only' }))

    await waitFor(() => expect(screen.queryByLabelText('Schedule')).toBeNull())
    expect(screen.getByLabelText('Time column')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/needs a time column/)).toBeNull()
    expect(screen.queryByText(/needs one to record metric points/)).toBeNull()
  })

  // The time column is required in monitoring and optional in Catalog only, so
  // only Catalog only may offer a way back to "no time column at all" — without
  // a selectable empty option a column could be set there and never removed.
  it('makes the empty time column selectable in Catalog only and not in monitoring', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')
    const emptyOption = () =>
      (screen.getByLabelText('Time column') as HTMLSelectElement).options[0]

    expect(emptyOption().disabled).toBe(true)

    fireEvent.click(screen.getByRole('radio', { name: 'Catalog only' }))
    await waitFor(() => expect(emptyOption().disabled).toBe(false))
  })

  // A lookback is `<time column> >= now() - N hours`. With no time column
  // resolve_lookback_window returns None and the run reads the whole base query,
  // so an input promising "how far back each run reads" would state a bound the
  // pipeline never applies.
  it('replaces Lookback (hours) with what actually happens when no time column is set', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')
    fireEvent.click(screen.getByRole('button', { name: /Limits/ }))

    expect(screen.queryByLabelText('Lookback (hours)')).toBeNull()
    expect(
      screen.getByText(
        'Each run reads everything the base query returns. Pick a Time column to bound runs to a window.',
      ),
    ).toBeInTheDocument()
  })

  // The defect: on the old defaults this scan was creatable, ran green forever,
  // and collected no metric point, raised no anomaly and sent no alert.
  it('flags both missing columns in Catalog + monitoring and refuses to create the scan', async () => {
    setupFetch([eventType])
    renderCreatePage()

    await screen.findByText('New scan')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main scan' } })
    fireEvent.change(screen.getByLabelText('Data source'), { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByPlaceholderText('SELECT * FROM analytics.events'), {
      target: { value: 'SELECT * FROM analytics.events' },
    })
    // How events are named is asked for before the time column, so answer it —
    // otherwise its own blocker is the one on the button.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Purchase' })).toBeInTheDocument(),
    )
    fireEvent.change(screen.getByLabelText('Event type'), { target: { value: 'et-1' } })

    expect(
      screen.getByText('Load a preview to choose a time column — monitoring needs one.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Pick a schedule — monitoring needs one to record metric points.'),
    ).toBeInTheDocument()

    const create = screen.getByRole('button', { name: /Create scan/ })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute(
      'title',
      'Catalog + monitoring needs a time column and a schedule.',
    )
  })

  // People stop reading a warning that fires on the ordinary path. A new scan
  // opens on Catalog + monitoring with neither the time column nor the schedule
  // set, so both alerts rendered on first paint — before a name, a source or a
  // query, and one of them pointing at a select the form had not enabled yet
  // (its options come from the preview). Red on an untouched form teaches the
  // user that red is decoration, on the one form where it later means "this scan
  // will never collect anything".
  it('says nothing in warning colour on a form nobody has typed into yet', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')

    expect(screen.queryAllByRole('alert')).toHaveLength(0)
    expect(
      screen.queryByText('Load a preview to choose a time column — monitoring needs one.'),
    ).toBeNull()
    expect(
      screen.queryByText('Pick a schedule — monitoring needs one to record metric points.'),
    ).toBeNull()
    // Nothing is lost: the gate is still on, and the button still says why.
    const create = screen.getByRole('button', { name: /Create scan/ })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('title', 'A scan needs a name, a data source and a base query.')
  })

  // The other half of the same gate: suppressing the alerts must not silence the
  // case they exist for. A saved config with a schedule and no time column is
  // the never-dispatched one, and it arrives with everything else already
  // answered — so its Configuration tab flags the fault the moment it opens.
  it('flags the missing time column as soon as a never-dispatched scan is opened', async () => {
    setupFetch()
    renderConfigurationTab({
      id: 'sc-2',
      data_source_id: 'ds-1',
      name: 'Scheduled but idle',
      base_query: 'SELECT * FROM analytics.events',
      event_type_column: 'event_name',
      time_column: null,
      interval: '1h',
      cardinality_threshold: 100,
    } as unknown as ScanConfig)

    expect(
      await screen.findByText('Load a preview to choose a time column — monitoring needs one.'),
    ).toBeInTheDocument()
  })

  it('never offers a way to say "no time series" or "no schedule" inside monitoring', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')

    expect(screen.queryByText('No time series')).toBeNull()
    expect(screen.queryByText('No schedule (manual)')).toBeNull()
    expect(screen.getByRole('option', { name: 'Choose a schedule' })).toBeDisabled()
  })

  // The user-facing half of the same defect: the column was not only nulled on
  // save, it was invisible on the screen that nulled it. A saved config opens
  // its edit form with no preview loaded, so the value has to be among the
  // select's own options or the placeholder wins and an existing time column
  // reads as "not set".
  it('shows a saved catalog scan its own time column before any preview is loaded', async () => {
    setupFetch()
    renderConfigurationTab({
      id: 'sc-1',
      data_source_id: 'ds-1',
      name: 'Nightly catalog',
      base_query: 'SELECT * FROM analytics.events',
      time_column: 'event_ts',
      interval: null,
      scan_lookback_hours: 24,
      cardinality_threshold: 100,
    } as unknown as ScanConfig)

    // No schedule, so the form opens on Catalog only…
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Catalog only' })).toBeChecked(),
    )
    // …and the column that bounds every run is on screen, not hidden.
    expect(screen.getByLabelText('Time column')).toHaveValue('event_ts')

    fireEvent.click(screen.getByRole('button', { name: /Limits/ }))
    expect(screen.getByLabelText('Lookback (hours)')).toHaveValue(24)
  })

  // Breakdowns and drift only shape metric series; in Catalog only there are no
  // series, so the section is a question with no meaning.
  it('hides the metric breakdown section entirely in Catalog only', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan')
    expect(screen.getByRole('button', { name: /Metric breakdowns and drift/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Catalog only' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Metric breakdowns and drift/ })).toBeNull(),
    )
  })
})
