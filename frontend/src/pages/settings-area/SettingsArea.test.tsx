import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectsApi } from '@/api/projects'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import type { Project } from '@/types'
import SettingsArea from './SettingsArea'

const LAST_SLUG_STORAGE_KEY = 'tripl-last-project-slug'

function ownerAuthValue(): AuthContextValue {
  return {
    user: {
      id: 'owner-1',
      email: 'owner@example.com',
      name: 'owner',
      role: 'owner',
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

function project(slug: string, name: string): Project {
  return {
    id: slug,
    name,
    slug,
    description: '',
    app_version_keep_releases: 5,
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
      monitoring_signal_count: 0,
      firing_monitor_count: 0,
      failing_scan_config_count: 0,
      latest_scan_job: null,
      latest_signal: null,
    },
  }
}

// GET /projects returns windy-android first — the project the takeover used to
// bind to when nothing had been chosen (tripl-jfm3.32).
const projects = [project('windy-android', 'Windy Android'), project('windy-ios', 'Windy iOS')]

function renderArea(section: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={ownerAuthValue()}>
        <MemoryRouter initialEntries={[`/settings/${section}`]}>
          <SettingsArea section={section} />
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('SettingsArea project binding', () => {
  it('asks the user to pick a project instead of binding to the first one', async () => {
    vi.spyOn(projectsApi, 'list').mockResolvedValue(projects)

    renderArea('project/general')

    expect(await screen.findByText('No project selected.')).toBeInTheDocument()
    // Never silently offers to edit whichever project happened to sort first.
    await waitFor(() => {
      expect(screen.queryByText('Windy Android')).not.toBeInTheDocument()
    })
    // "Back to project" falls back to the workspace, not to /p/windy-android.
    expect(screen.getByRole('link', { name: /Back to project/i })).toHaveAttribute(
      'href',
      '/workspace',
    )
  })

  it('binds to the last project the user actually visited', async () => {
    vi.spyOn(projectsApi, 'list').mockResolvedValue(projects)
    window.localStorage.setItem(LAST_SLUG_STORAGE_KEY, 'windy-ios')

    renderArea('project/general')

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Back to project/i })).toHaveAttribute(
        'href',
        '/p/windy-ios/events',
      )
    })
    // The rail names the bound project, and it is the one the user last opened.
    expect(screen.getByText('Windy iOS')).toBeInTheDocument()
    expect(screen.queryByText('Windy Android')).not.toBeInTheDocument()
  })

  it('ignores a stale last-visited slug that is no longer a project', async () => {
    vi.spyOn(projectsApi, 'list').mockResolvedValue(projects)
    window.localStorage.setItem(LAST_SLUG_STORAGE_KEY, 'deleted-project')

    renderArea('project/general')

    expect(await screen.findByText('No project selected.')).toBeInTheDocument()
  })

  it('still renders workspace sections with no project bound', async () => {
    vi.spyOn(projectsApi, 'list').mockResolvedValue(projects)

    renderArea('api-keys')

    expect(await screen.findByText('All keys')).toBeInTheDocument()
    expect(screen.queryByText('No project selected.')).not.toBeInTheDocument()
  })
})
