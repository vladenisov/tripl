import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetaFieldDefinition } from '@/types'
import { metaFieldsApi } from '@/api/metaFields'
import { MetaFieldsTab } from './MetaFieldsTab'

vi.mock('@/api/metaFields', () => ({
  metaFieldsApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  },
}))

function metaField(over: Partial<MetaFieldDefinition> & { id: string; name: string }) {
  return {
    project_id: 'project-1',
    display_name: over.display_name ?? over.name,
    field_type: 'string',
    is_required: false,
    allow_multiple: false,
    enum_options: null,
    default_value: null,
    link_template: null,
    order: 0,
    sensitivity: 'none',
    ...over,
  } as MetaFieldDefinition
}

function renderTab(fields: MetaFieldDefinition[] = []) {
  vi.mocked(metaFieldsApi.list).mockResolvedValue(fields)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MetaFieldsTab slug="demo" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('MetaFieldsTab — Allow multiple (tripl-h2sx.31)', () => {
  it('sends the flag when the box is ticked', async () => {
    vi.mocked(metaFieldsApi.create).mockResolvedValue(metaField({ id: 'mf-1', name: 'jira_keys' }))
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /Add meta field/i }))
    fireEvent.change(screen.getByLabelText(/Name \(e.g. jira_link\)/), {
      target: { value: 'jira_keys' },
    })
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Jira keys' } })
    fireEvent.click(screen.getByLabelText('Multiple values'))
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(metaFieldsApi.create).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({ name: 'jira_keys', allow_multiple: true }),
        null,
      ),
    )
  })

  it('does not offer the box for a type that cannot hold a list', async () => {
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /Add meta field/i }))
    expect(screen.getByLabelText('Multiple values')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'date' } })
    expect(screen.queryByLabelText('Multiple values')).not.toBeInTheDocument()
  })

  it('drops a tick left behind by a type switch instead of sending a 422', async () => {
    vi.mocked(metaFieldsApi.create).mockResolvedValue(metaField({ id: 'mf-1', name: 'shipped' }))
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: /Add meta field/i }))
    fireEvent.change(screen.getByLabelText(/Name \(e.g. jira_link\)/), {
      target: { value: 'shipped' },
    })
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Shipped' } })
    fireEvent.click(screen.getByLabelText('Multiple values'))
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'boolean' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(metaFieldsApi.create).toHaveBeenCalledWith(
        'demo',
        expect.objectContaining({ field_type: 'boolean', allow_multiple: false }),
        null,
      ),
    )
  })

  it('warns that stored values stay when the flag is turned off', async () => {
    renderTab([metaField({ id: 'mf-1', name: 'jira_keys', allow_multiple: true })])

    fireEvent.click(await screen.findByRole('button', { name: 'Edit jira_keys' }))
    expect(screen.getByLabelText('Multiple values')).toBeChecked()
    expect(screen.queryByText(/keeps the first value only/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Multiple values'))
    expect(screen.getByText(/keeps the first value only/)).toBeInTheDocument()
  })
})
