import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchApi } from '@/api/search'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import ProjectGeneralSection from './ProjectGeneralSection'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const PROJECT = {
  id: 'project-1',
  name: 'Demo',
  slug: 'demo',
  description: '',
  app_version_keep_releases: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  summary: {
    event_type_count: 0,
    event_count: 0,
    active_event_count: 0,
    implemented_event_count: 0,
    review_pending_event_count: 0,
    archived_event_count: 0,
    variable_count: 0,
    scan_count: 0,
    alert_destination_count: 0,
    alert_rule_count: 0,
    monitoring_signal_count: 0,
    latest_scan_job: null,
    latest_signal: null,
  },
}

function authValue(role: 'owner' | 'editor' | 'viewer'): AuthContextValue {
  return {
    user: {
      id: `${role}-1`,
      email: `${role}@example.com`,
      name: role,
      role,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: async () => {},
    refresh: () => {},
  }
}

function ownerAuthValue(): AuthContextValue {
  return authValue('owner')
}

function renderSection(
  auth: AuthContextValue = ownerAuthValue(),
  initialProject?: typeof PROJECT,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (initialProject) {
    queryClient.setQueryDefaults(['project', initialProject.slug], { staleTime: Infinity })
    queryClient.setQueryData(['project', initialProject.slug], initialProject)
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={['/settings/project/general']}>
          <ProjectGeneralSection slug="demo" />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProjectGeneralSection', () => {
  it('updates the shared app-version retention policy', async () => {
    let patchBody: { app_version_keep_releases?: number } | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(PROJECT)
      }
      if (url.endsWith('/api/v1/projects/demo') && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body)) as { app_version_keep_releases?: number }
        return jsonResponse({ ...PROJECT, ...patchBody })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    const input = await screen.findByLabelText('Releases to keep')
    expect(input).toHaveValue(3)
    fireEvent.change(input, { target: { value: '4' } })
    const card = screen.getByText('Version monitoring').closest('section')
    expect(card).not.toBeNull()
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchBody).toEqual({ app_version_keep_releases: 4 })
    })
  })

  it('rebuilds the search index', async () => {
    const reindex = vi.spyOn(searchApi, 'reindex').mockResolvedValue({
      documents_indexed: 42,
      embeddings_scheduled: false,
    })

    renderSection(ownerAuthValue(), PROJECT)

    fireEvent.click(screen.getByRole('button', { name: /Rebuild index/i }))

    expect(await screen.findByText('Indexed 42 documents.')).toBeInTheDocument()
    expect(reindex).toHaveBeenCalledWith('demo')
  })

  it('prefixes the slug with this instance host, not a stand-in domain', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    // The affix read a hardcoded "example.com/p/" on every install (tripl-gex5),
    // so the one screen that shows a reader their project's address showed
    // somebody else's. Asserted against the host the tree is served from, which
    // is the whole point — no literal can satisfy this on two different hosts.
    expect(await screen.findByText(`${window.location.host}/p/`)).toBeInTheDocument()
  })

  it('hides the unfinished "Coming soon" project-config fields for release', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    // Wait for the project to load (the Save button renders once it resolves).
    expect((await screen.findAllByRole('button', { name: /Save/i })).length).toBeGreaterThan(0)

    // The four preview-only fields (accent color + the Defaults trio) are gone.
    // "Timezone" here is scoped to this section — ProfileSection's real Timezone
    // is a different component and is not rendered in this tree.
    expect(screen.queryByText('Accent color')).toBeNull()
    expect(screen.queryByText('Default branch')).toBeNull()
    expect(screen.queryByText('Default environment')).toBeNull()
    expect(screen.queryByText('Timezone')).toBeNull()

    // No inert "Coming soon" badges survive in the release view.
    expect(screen.queryByText(/Coming soon/i)).toBeNull()

    // Every remaining <select> in the section is an enabled danger-zone period
    // control — there are no disabled preview selects left.
    screen
      .getAllByRole('combobox')
      .forEach((select) => expect(select).not.toBeDisabled())
  })

  it('cross-links to the in-app Project operations surface', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    expect(
      await screen.findByRole('button', { name: /Project operations/i }),
    ).toBeInTheDocument()
  })

  it('exposes a Delete project danger action for owners', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    expect(await screen.findByRole('button', { name: /Delete project/ })).toBeInTheDocument()
  })

  it('shows both reset danger actions to owners', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    expect(await screen.findByRole('button', { name: 'Reset anomalies' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset drifts' })).toBeInTheDocument()
  })

  it('hides the reset danger actions from non-owners', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo')) return jsonResponse(PROJECT)
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection(authValue('editor'))

    // Wait for the project to load (Delete row always renders), then confirm the
    // owner-only reset actions are absent.
    await screen.findByRole('button', { name: /Delete project/ })
    expect(screen.queryByRole('button', { name: 'Reset anomalies' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset drifts' })).not.toBeInTheDocument()
  })

  it('resets anomalies with the chosen period after confirmation', async () => {
    let resetBody: { before?: string | null; after?: string | null } | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(PROJECT)
      }
      if (
        url.endsWith('/api/v1/projects/demo/danger/reset-anomalies') &&
        init?.method === 'POST'
      ) {
        resetBody = JSON.parse(String(init?.body))
        return jsonResponse({ metric_anomalies: 5, metric_breakdown_anomalies: 2 })
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    renderSection()

    // Pick "Older than 7 days" (not the 30-day default) to prove the period ships.
    fireEvent.change(await screen.findByLabelText('Reset anomalies period'), {
      target: { value: '7d' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reset anomalies' }))

    // Confirm in the irreversible-action dialog.
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset anomalies' }))

    expect(
      await screen.findByText('Cleared 5 anomalies and 2 breakdown anomalies.'),
    ).toBeInTheDocument()

    expect(resetBody).not.toBeNull()
    const body = resetBody as unknown as { before: string; after: string | null }
    expect(body.after).toBeNull()
    // The cutoff must be ~7 days ago (the chosen window), not the 30-day default.
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    expect(Math.abs(Date.now() - Date.parse(body.before) - sevenDaysMs)).toBeLessThan(60_000)
  })
})
