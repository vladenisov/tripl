import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

// The audit list endpoint is stubbed so the tab renders its filter card without
// firing a real request; the From/To hint text is static and present regardless.
vi.mock('@/api/audit', () => ({
  auditApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
}))

import { AuditTab } from './AuditTab'

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuditTab slug="demo" />
    </QueryClientProvider>,
  )
}

/** Every action the Action <select> offers, in DOM order (minus "All actions"). */
function offeredActions(): string[] {
  const select = screen.getByLabelText('Action') as HTMLSelectElement
  return Array.from(select.querySelectorAll('option'))
    .map((option) => option.value)
    .filter((value) => value !== '')
}

describe('AuditTab — action filter vocabulary (tripl-jfm3.79)', () => {
  // The list query is ALWAYS narrowed by projectSlug, so an offered action the
  // backend records without a project scope can never match anything — the
  // filter just reports "no entries" for a project that did the thing.
  it('does not offer actions the backend never scopes to a project', () => {
    renderTab()

    const actions = offeredActions()

    // api/v1/data_sources.py records these with no project/project_slug — a
    // data source is instance-level — so they were dead options here.
    expect(actions).not.toContain('data_source.create')
    expect(actions).not.toContain('data_source.update')
    expect(actions).not.toContain('data_source.delete')
    // api/v1/users.py and the workspace half of api/v1/api_keys.py likewise.
    expect(actions).not.toContain('user.role_update')
    expect(actions).not.toContain('api_key.revoke')
  })

  it('offers the project-scoped actions the backend actually records', () => {
    renderTab()

    const actions = offeredActions()

    // Families that the backend has recorded per-project all along but the
    // filter had no entry for, so they could never be isolated.
    for (const action of [
      'plan_branch.create',
      'plan_branch.merge',
      'plan_branch.approve',
      'scan_job.cancel',
      'scan_config.event_groups.apply',
      'metric_definition.create',
      'fact_table.create',
      'variable.bulk_update',
      'variable.override_set',
      'event_type.add_owner',
      'schema_drift.accept',
      'alert_inbox.acknowledge',
      'alert_rule.mute',
      'alert_delivery.retry',
      'project.reset_anomalies',
      'project_tracker_config.update',
    ]) {
      expect(actions).toContain(action)
    }
  })

  it('lists each action once', () => {
    renderTab()

    const actions = offeredActions()
    expect(actions).toHaveLength(new Set(actions).size)
  })
})

describe('AuditTab — date filters (tripl-jfm3.37)', () => {
  it('labels the date filters without a format hint the control contradicts', () => {
    renderTab()

    // The native <input type="date"> renders and parses in the BROWSER's locale
    // (mm/dd/yyyy on a US profile), so a hard-coded "(YYYY-MM-DD)" told the user
    // one format while the widget showed another.
    expect(screen.queryByText('(YYYY-MM-DD)')).toBeNull()

    // The fields themselves are unchanged — still native date pickers, still
    // labelled From/To.
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date')
  })
})
