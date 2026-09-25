import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { toast } from 'sonner'
import { surfaceMutationError } from '@/lib/errorFeedback'
import { createElement, type ReactNode } from 'react'
import { AuthContext } from '@/components/auth-context'
import { authAs } from '@/test/auth'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, FactTable } from '@/types'
import { FactTableForm } from './FactTableForm'

vi.mock('@/api/factTablesApi', () => ({
  factTablesApi: {
    create: vi.fn().mockResolvedValue({ id: 'created' }),
    update: vi.fn().mockResolvedValue({ id: 'updated' }),
    preview: vi.fn(),
  },
}))

// CodeMirror needs real layout measurement jsdom can't provide; stub it with a
// plain textarea that forwards value/onChange/placeholder and the aria-label so
// the SQL editor stays queryable by accessible name.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    placeholder,
    readOnly,
    'aria-label': ariaLabel,
  }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
    readOnly?: boolean
    'aria-label'?: string
  }) => (
    <textarea
      aria-label={ariaLabel}
      readOnly={readOnly}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  ),
}))

// The SQL editor fetches the data-source schema for autocomplete; stub it so the
// form test never reaches the network.
const { useDataSourceSchemaMock } = vi.hoisted(() => ({
  useDataSourceSchemaMock: vi.fn<(dsId?: string) => { data: unknown }>(() => ({ data: undefined })),
}))
vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: useDataSourceSchemaMock,
  toSQLNamespace: () => ({}),
}))

import { factTablesApi } from '@/api/factTablesApi'

const DATA_SOURCES = [{ id: 'ds-1', name: 'Warehouse' }] as unknown as DataSource[]

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

function renderForm(factTable: FactTable | null = null) {
  const onClose = vi.fn()
  render(
    createElement(FactTableForm, {
      slug: 'demo',
      factTable,
      dataSources: DATA_SOURCES,
      onClose,
    }),
    { wrapper },
  )
  return { onClose }
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
    target: { value: 'Orders' },
  })
  fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
    target: { value: 'orders' },
  })
  fireEvent.change(document.getElementById('fact-data-source')!, { target: { value: 'ds-1' } })
  fireEvent.change(screen.getByLabelText('Fact table SQL'), {
    target: { value: 'SELECT id, user_id, created_at FROM orders' },
  })
  fireEvent.change(document.getElementById('fact-timestamp')!, { target: { value: 'created_at' } })
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /Create fact table|Save fact table/ }))
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(factTablesApi.create).mockClear()
  vi.mocked(factTablesApi.update).mockClear()
  vi.mocked(factTablesApi.preview).mockReset()
})

afterEach(() => {
  queryClient.clear()
})

describe('FactTableForm', () => {
  it('rejects a create that is missing required fields', async () => {
    renderForm()

    submit()

    expect(await screen.findByText('Display name is required.')).toBeInTheDocument()
    expect(screen.getByText('Internal name is required.')).toBeInTheDocument()
    expect(screen.getByText('A data source is required.')).toBeInTheDocument()
    expect(screen.getByText('The fact table SQL is required.')).toBeInTheDocument()
    expect(screen.getByText('A timestamp column is required.')).toBeInTheDocument()
    expect(factTablesApi.create).not.toHaveBeenCalled()
  })

  it('previews columns and persists them on create', async () => {
    vi.mocked(factTablesApi.preview).mockResolvedValue({
      columns: [
        { name: 'id', type: 'bigint' },
        { name: 'user_id', type: 'uuid' },
        { name: 'created_at', type: 'timestamp' },
      ],
      identifier_candidates: ['user_id'],
    })

    const { onClose } = renderForm()
    fillRequired()

    fireEvent.click(screen.getByRole('button', { name: /Preview columns/ }))

    // Preview was sent with the SQL + source + timestamp.
    await waitFor(() => expect(factTablesApi.preview).toHaveBeenCalledTimes(1))
    expect(factTablesApi.preview).toHaveBeenCalledWith('demo', {
      data_source_id: 'ds-1',
      sql: 'SELECT id, user_id, created_at FROM orders',
      timestamp_column: 'created_at',
    })

    // Returned columns render with their type badges.
    const list = await screen.findByLabelText('Fact table columns')
    expect(list).toHaveTextContent('id')
    expect(list).toHaveTextContent('bigint')
    expect(list).toHaveTextContent('user_id')
    expect(screen.getByText(/Suggested identifiers:/)).toBeInTheDocument()

    submit()

    await waitFor(() => expect(factTablesApi.create).toHaveBeenCalledTimes(1))
    expect(factTablesApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        name: 'orders',
        display_name: 'Orders',
        data_source_id: 'ds-1',
        timestamp_column: 'created_at',
        sql: 'SELECT id, user_id, created_at FROM orders',
        columns: [
          { name: 'id', type: 'bigint' },
          { name: 'user_id', type: 'uuid' },
          { name: 'created_at', type: 'timestamp' },
        ],
        identifier_columns: ['user_id'],
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('collects named row filters into the create payload', async () => {
    renderForm()
    fillRequired()

    fireEvent.click(screen.getByRole('button', { name: /Add row filter/ }))
    const nameInput = screen.getByPlaceholderText('mobile_only')
    const sqlInput = screen.getByPlaceholderText("platform = 'ios'")
    fireEvent.change(nameInput, { target: { value: 'ios_only' } })
    fireEvent.change(sqlInput, { target: { value: "platform = 'ios'" } })

    submit()

    await waitFor(() => expect(factTablesApi.create).toHaveBeenCalledTimes(1))
    expect(factTablesApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        row_filters: [{ name: 'ios_only', sql: "platform = 'ios'" }],
      }),
    )
  })

  it('refuses a save whose row filters repeat a name', async () => {
    renderForm()
    fillRequired()

    fireEvent.click(screen.getByRole('button', { name: /Add row filter/ }))
    fireEvent.click(screen.getByRole('button', { name: /Add row filter/ }))
    fireEvent.change(screen.getByLabelText('Row filter 1 name'), { target: { value: 'ios_only' } })
    fireEvent.change(screen.getByLabelText('Row filter 1 SQL condition'), {
      target: { value: "platform = 'ios'" },
    })
    // Trailing space on the repeat: the payload is trimmed, so the two names
    // collide in the request even though the inputs do not look identical.
    fireEvent.change(screen.getByLabelText('Row filter 2 name'), { target: { value: 'ios_only ' } })
    fireEvent.change(screen.getByLabelText('Row filter 2 SQL condition'), {
      target: { value: "platform = 'ipados'" },
    })

    submit()

    expect(await screen.findByText(/Two row filters are named "ios_only"/)).toBeInTheDocument()
    expect(factTablesApi.create).not.toHaveBeenCalled()
  })

  it('preview keeps saved identifier picks and only adds new suggestions (tripl-4qfr)', async () => {
    const columns = [
      { name: 'paid', type: 'string' },
      { name: 'android', type: 'string' },
      { name: 'country', type: 'string' },
      { name: 'user_id', type: 'string' },
      { name: 'created_at', type: 'timestamp' },
    ]
    // The tightened count_distinct heuristic now suggests only user_id + country
    // and no longer suggests the previously-saved picks paid / android.
    vi.mocked(factTablesApi.preview).mockResolvedValue({
      columns,
      identifier_candidates: ['user_id', 'country'],
    })

    const existing = {
      id: 'ft-9',
      project_id: 'p-1',
      name: 'events',
      display_name: 'Events',
      description: '',
      color: '#6366f1',
      order: 0,
      data_source_id: 'ds-1',
      timestamp_column: 'created_at',
      columns,
      // Manual picks saved in an earlier session, including paid / android which
      // the current (stricter) heuristic no longer suggests.
      identifier_columns: ['paid', 'android', 'user_id'],
      row_filters: [],
      sql: 'SELECT paid, android, country, user_id, created_at FROM events',
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-20T00:00:00Z',
    } as unknown as FactTable

    renderForm(existing)

    // Saved picks render checked.
    expect(screen.getByLabelText('Use paid as an identifier column')).toBeChecked()
    expect(screen.getByLabelText('Use android as an identifier column')).toBeChecked()

    // First preview of the edit session: it must NOT silently uncheck saved picks
    // the heuristic dropped, but it DOES surface the newly-suggested column.
    fireEvent.click(screen.getByRole('button', { name: /Preview columns/ }))
    await waitFor(() =>
      expect(screen.getByLabelText('Use country as an identifier column')).toBeChecked(),
    )
    expect(screen.getByLabelText('Use paid as an identifier column')).toBeChecked()
    expect(screen.getByLabelText('Use android as an identifier column')).toBeChecked()
    expect(screen.getByLabelText('Use user_id as an identifier column')).toBeChecked()

    // In-session manual removal still persists across a re-preview: uncheck
    // user_id, then re-preview and confirm it stays unchecked while the saved
    // picks remain.
    fireEvent.click(screen.getByLabelText('Use user_id as an identifier column'))

    fireEvent.click(screen.getByRole('button', { name: /Preview columns/ }))
    await waitFor(() => expect(factTablesApi.preview).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Preview columns/ })).toBeEnabled(),
    )
    expect(screen.getByLabelText('Use user_id as an identifier column')).not.toBeChecked()
    expect(screen.getByLabelText('Use paid as an identifier column')).toBeChecked()
    expect(screen.getByLabelText('Use country as an identifier column')).toBeChecked()

    submit()

    await waitFor(() => expect(factTablesApi.update).toHaveBeenCalledTimes(1))
    const [, , payload] = vi.mocked(factTablesApi.update).mock.calls[0]
    const identifiers = (payload as { identifier_columns: string[] }).identifier_columns
    expect(identifiers).toEqual(expect.arrayContaining(['paid', 'android', 'country']))
    expect(identifiers).not.toContain('user_id')
    expect(identifiers).toHaveLength(3)
  })

  it('renders the internal name read-only when editing and omits it from the update', async () => {
    const existing = {
      id: 'ft-9',
      project_id: 'p-1',
      name: 'orders',
      display_name: 'Orders',
      description: '',
      color: '#6366f1',
      order: 0,
      data_source_id: 'ds-1',
      timestamp_column: 'created_at',
      columns: [{ name: 'id', type: 'bigint' }],
      identifier_columns: ['id'],
      row_filters: [],
      sql: 'SELECT id, created_at FROM orders',
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-20T00:00:00Z',
    } as unknown as FactTable

    renderForm(existing)

    // No editable internal-name input; the name is shown as static text.
    expect(document.getElementById('fact-name')).toBeNull()

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Orders renamed' },
    })
    submit()

    await waitFor(() => expect(factTablesApi.update).toHaveBeenCalledTimes(1))
    const [, factTableId, payload] = vi.mocked(factTablesApi.update).mock.calls[0]
    expect(factTableId).toBe('ft-9')
    expect(payload).not.toHaveProperty('name')
    expect(payload).toMatchObject({ display_name: 'Orders renamed' })
  })
})

/** Whether a reload/tab-close right now would get the browser's prompt. */
function reloadIsGuarded(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('FactTableForm unsaved-changes guard (MET-5)', () => {
  it('arms the reload prompt once the draft differs from what the form opened with', () => {
    renderForm()
    expect(reloadIsGuarded()).toBe(false)

    fillRequired()
    expect(reloadIsGuarded()).toBe(true)
  })

  it('leaves an untouched edit form unguarded, row filters included', () => {
    renderForm({
      id: 'ft-1',
      project_id: 'p-1',
      name: 'orders',
      display_name: 'Orders',
      description: '',
      color: '#6366f1',
      order: 0,
      data_source_id: 'ds-1',
      timestamp_column: 'created_at',
      columns: [],
      identifier_columns: [],
      // Each row gets a fresh client-side id on mount; those are not edits.
      row_filters: [{ name: 'ios_only', sql: "platform = 'ios'" }],
      sql: 'SELECT id, created_at FROM orders',
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-20T00:00:00Z',
    } as unknown as FactTable)
    expect(reloadIsGuarded()).toBe(false)
  })
})

const VIEWER = authAs('viewer')

describe('FactTableForm for a viewer', () => {
  const SAVED = {
    id: 'ft-1',
    project_id: 'p-1',
    name: 'orders',
    display_name: 'Orders',
    description: '',
    color: '#6366f1',
    order: 0,
    data_source_id: 'ds-1',
    timestamp_column: 'created_at',
    columns: [],
    identifier_columns: [],
    row_filters: [],
    sql: 'SELECT id, created_at FROM orders',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  } as unknown as FactTable

  it('shows the SQL read-only and never asks for the editor-only schema', () => {
    useDataSourceSchemaMock.mockClear()
    render(
      createElement(
        AuthContext.Provider,
        { value: VIEWER },
        createElement(FactTableForm, {
          slug: 'demo',
          factTable: SAVED,
          dataSources: DATA_SOURCES,
          onClose: vi.fn(),
        }),
      ),
      { wrapper },
    )

    expect(screen.getByLabelText('Fact table SQL')).toHaveAttribute('readonly')
    expect(useDataSourceSchemaMock).toHaveBeenCalled()
    expect(useDataSourceSchemaMock.mock.calls.every(([dsId]) => dsId === undefined)).toBe(true)
  })

  it('asks an editor for the schema of the chosen source', () => {
    useDataSourceSchemaMock.mockClear()
    renderForm(SAVED)

    expect(screen.getByLabelText('Fact table SQL')).not.toHaveAttribute('readonly')
    expect(useDataSourceSchemaMock).toHaveBeenCalledWith('ds-1')
  })
})

describe('FactTableForm save failure', () => {
  it('says it once, inline, and keeps the app-wide toast quiet', async () => {
    // The backstop main.tsx registers, so the test sees what the app does.
    queryClient = new QueryClient({
      mutationCache: new MutationCache({ onError: surfaceMutationError }),
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const toastError = vi.spyOn(toast, 'error')
    vi.mocked(factTablesApi.create).mockRejectedValueOnce(new Error('Name already taken'))
    renderForm()

    fillRequired()
    submit()

    expect(await screen.findByText('Could not save fact table')).toBeInTheDocument()
    expect(toastError).not.toHaveBeenCalled()
    toastError.mockRestore()
  })
})
