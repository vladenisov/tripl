import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
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
    'aria-label': ariaLabel,
  }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
    'aria-label'?: string
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  ),
}))

// The SQL editor fetches the data-source schema for autocomplete; stub it so the
// form test never reaches the network.
vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({ data: undefined }),
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
      sample_rows: [],
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
