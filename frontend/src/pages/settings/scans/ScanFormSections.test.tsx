import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScanCreatePage } from './ScanConfigForm'

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

function setupFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.includes('/data-sources/') && url.includes('/schema')) {
      return mockJsonResponse({ tables: [] })
    }
    if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
    if (url.includes('/event-types')) return mockJsonResponse([])
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

    await screen.findByText('New scan config')

    expect(screen.queryByLabelText('Cardinality threshold')).toBeNull()
    expect(screen.queryByLabelText('Row cap per metrics run')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Event names and grouping/ }))
    expect(screen.getByLabelText('Cardinality threshold')).toBeInTheDocument()
  })

  it('shows the four plain questions without opening anything', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan config')

    expect(screen.getByLabelText('Name')).toBeInTheDocument()
    expect(screen.getByLabelText('Data source')).toBeInTheDocument()
    expect(screen.getByLabelText('Event type')).toBeInTheDocument()
    expect(screen.getByLabelText('Schedule')).toBeInTheDocument()
  })
})

describe('ScanFormSections — the mode choice', () => {
  it('defaults a new scan to Catalog + monitoring', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan config')
    expect(screen.getByRole('radio', { name: 'Catalog + monitoring' })).toBeChecked()
  })

  // Empty is a deliberate answer in Catalog only. Warning about it there would be
  // the product second-guessing a choice the user just made.
  it('drops the time column and schedule in Catalog only and says nothing about them', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan config')
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog only' }))

    await waitFor(() => expect(screen.queryByLabelText('Schedule')).toBeNull())
    expect(screen.queryByLabelText('Time column')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/needs a time column/)).toBeNull()
    expect(screen.queryByText(/needs one to collect metrics/)).toBeNull()
  })

  // The defect: on the old defaults this scan was creatable, ran green forever,
  // and collected no metric point, raised no anomaly and sent no alert.
  it('flags both missing columns in Catalog + monitoring and refuses to create the scan', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan config')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Main scan' } })
    fireEvent.change(screen.getByLabelText('Data source'), { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByPlaceholderText('SELECT * FROM analytics.events'), {
      target: { value: 'SELECT * FROM analytics.events' },
    })

    expect(
      screen.getByText('Pick a time column — monitoring needs one to build a time series.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Pick a schedule — monitoring needs one to collect metrics.'),
    ).toBeInTheDocument()

    const create = screen.getByRole('button', { name: /Create scan/ })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute(
      'title',
      'Catalog + monitoring needs a time column and a schedule.',
    )
  })

  it('never offers a way to say "no time series" or "no schedule" inside monitoring', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan config')

    expect(screen.queryByText('No time series')).toBeNull()
    expect(screen.queryByText('No schedule (manual)')).toBeNull()
    expect(screen.getByRole('option', { name: 'Choose a schedule' })).toBeDisabled()
  })

  // Breakdowns and drift only shape metric series; in Catalog only there are no
  // series, so the section is a question with no meaning.
  it('hides the metric breakdown section entirely in Catalog only', async () => {
    setupFetch()
    renderCreatePage()

    await screen.findByText('New scan config')
    expect(screen.getByRole('button', { name: /Metric breakdowns and drift/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Catalog only' }))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Metric breakdowns and drift/ })).toBeNull(),
    )
  })
})
