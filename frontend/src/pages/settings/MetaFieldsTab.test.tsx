import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetaFieldDefinition, Project } from '@/types'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import { authAs } from '@/test/auth'
import { ActiveProjectContext } from '@/components/active-project-context'
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

function renderTab(
  fields: MetaFieldDefinition[] | null = [],
  {
    auth = null,
    project,
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  }: { auth?: AuthContextValue | null; project?: Project; queryClient?: QueryClient } = {},
) {
  // `null` leaves the list mock to the test, for a pending or failing load.
  if (fields) vi.mocked(metaFieldsApi.list).mockResolvedValue(fields)
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        {/* What the app shell provides once it has resolved the URL's project. */}
        <ActiveProjectContext.Provider value={project}>
          <MetaFieldsTab slug="demo" />
        </ActiveProjectContext.Provider>
      </AuthContext.Provider>
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

describe('MetaFieldsTab — read-only visitors', () => {
  const FIELD = metaField({ id: 'mf-1', name: 'jira_link', display_name: 'Jira link' })

  it('offers a viewer no write controls, and says why once', async () => {
    renderTab([FIELD], { auth: authAs('viewer') })

    expect(await screen.findByText('jira_link')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/viewer role/)
    expect(screen.queryByRole('button', { name: /Add meta field/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Jira link' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Jira link' })).not.toBeInTheDocument()
  })

  it("treats an editor in another user's demo as read-only, as the API does", async () => {
    const demo = { slug: 'demo', is_demo: true, created_by_user_id: 'someone-else' } as Project
    renderTab([FIELD], { auth: authAs('editor'), project: demo })

    expect(await screen.findByText('jira_link')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add meta field/ })).not.toBeInTheDocument()
  })

  it('lets an editor write in a demo they created', async () => {
    const demo = { slug: 'demo', is_demo: true, created_by_user_id: 'editor-1' } as Project
    renderTab([FIELD], { auth: authAs('editor'), project: demo })

    expect(await screen.findByRole('button', { name: 'Edit Jira link' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Add meta field/ })).toBeInTheDocument()
  })
})

describe('MetaFieldsTab — load and delete states (PLAN-41 / PLAN-54)', () => {
  const FIELD = metaField({ id: 'mf-1', name: 'jira_link', display_name: 'Jira link' })

  it('shows a skeleton, not "No meta fields", while the list loads', async () => {
    vi.mocked(metaFieldsApi.list).mockReturnValue(new Promise(() => {}))
    renderTab(null)

    expect(await screen.findByLabelText('Loading meta fields')).toBeInTheDocument()
    expect(screen.queryByText('No meta fields')).not.toBeInTheDocument()
  })

  it('shows a failed load as an error with a retry, not as an empty list', async () => {
    vi.mocked(metaFieldsApi.list).mockRejectedValue(new Error('boom'))
    renderTab(null)

    expect(await screen.findByText("Couldn't load meta fields")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('No meta fields')).not.toBeInTheDocument()
  })

  it('says a failed delete failed', async () => {
    vi.mocked(metaFieldsApi.del).mockRejectedValue(new Error('Field is referenced'))
    renderTab([FIELD], { auth: authAs('editor') })

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Jira link' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Field is referenced')
  })

  it("refreshes the branch review's project-wide meta-field cache after an edit", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // What BranchesTab reads the ticket link template from.
    queryClient.setQueryData(['metaFields', 'demo'], [FIELD])
    vi.mocked(metaFieldsApi.update).mockResolvedValue(FIELD)
    renderTab([FIELD], { auth: authAs('editor'), queryClient })

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Jira link' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(queryClient.getQueryState(['metaFields', 'demo'])?.isInvalidated).toBe(true),
    )
  })
})
