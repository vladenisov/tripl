import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthUser, ProjectLatestScanJob, ProjectSummary, Role } from '@/types'
import { AuthContext, type AuthContextValue } from './auth-context'
import { OnboardingChecklist } from './onboarding-checklist'
import { countRealSources } from './onboarding-utils'

// The checklist is role-aware (tripl-yfsj.4): it reads the current user's role
// via useAuth(), so tests must render it inside an AuthContext. `role: null`
// models an unauthenticated context (treated as a non-owner).
function authValue(role: Role | null): AuthContextValue {
  const user: AuthUser | null = role
    ? {
        id: 'u1',
        email: 'user@example.com',
        name: null,
        role,
        created_at: '2026-07-01T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
      }
    : null
  return {
    user,
    status: role ? 'authenticated' : 'anonymous',
    error: null,
    isLoggingOut: false,
    logout: async () => {},
    refresh: () => {},
  }
}

function makeSummary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
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
    firing_monitor_count: 0,
    failing_scan_config_count: 0,
    latest_scan_job: null,
    latest_signal: null,
    ...overrides,
  }
}

// A scan job that actually ran — this is what ticks "Run a scan", not a merely
// seeded ScanConfig (scan_count alone no longer counts).
function executedJob(
  status: ProjectLatestScanJob['status'] = 'completed',
): ProjectLatestScanJob {
  return {
    id: 'job-1',
    scan_config_id: 'scan-1',
    scan_name: 'Nightly scan',
    status,
    started_at: '2026-07-01T00:00:00Z',
    completed_at: status === 'completed' ? '2026-07-01T00:05:00Z' : null,
    result_summary: null,
    error_message: null,
    created_at: '2026-07-01T00:05:00Z',
  }
}

function renderChecklist(props: {
  summary: ProjectSummary | undefined
  sourceCount?: number
  slug?: string
  isDemo?: boolean
  // Defaults to 'owner' so the pre-role-awareness cases (all five steps count)
  // read exactly as before.
  role?: Role | null
}) {
  return render(
    <AuthContext.Provider value={authValue(props.role === undefined ? 'owner' : props.role)}>
      <MemoryRouter>
        <OnboardingChecklist
          slug={props.slug ?? 'demo'}
          summary={props.summary}
          sourceCount={props.sourceCount ?? 0}
          isDemo={props.isDemo}
        />
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

afterEach(() => {
  localStorage.clear()
})

describe('OnboardingChecklist', () => {
  it('renders the five core-loop steps with their deep links', () => {
    renderChecklist({ summary: makeSummary() })

    expect(screen.getByText('Get started')).toBeInTheDocument()

    const expected: ReadonlyArray<[RegExp, string]> = [
      [/Define your plan/, '/p/demo/events'],
      [/Connect a data source/, '/settings/data-sources'],
      [/Run a scan/, '/p/demo/scans'],
      [/Review reconciliation/, '/p/demo/reconciliation'],
      [/Set up alerting/, '/p/demo/settings/alerting'],
    ]
    for (const [name, href] of expected) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href)
    }
  })

  it('describes "Run a scan" by what a run produces, not by a baseline (tripl-3y7z)', () => {
    // The step ticks on ANY executed run, including a Catalog only scan's, and
    // the manual Run now it asks for calls `run_scan`, which writes events and
    // fields but never a metric point. "Pull recent volume so tripl can learn
    // the baseline" was therefore false for the very run that completes it.
    renderChecklist({ summary: makeSummary() })

    const body = document.body.textContent ?? ''
    expect(body).not.toMatch(/learn the baseline/i)
    expect(body).not.toMatch(/Pull recent volume/i)
    expect(screen.getByText(/Catalog \+ monitoring/)).toBeInTheDocument()
  })

  it('auto-derives the completed count from project state', () => {
    // plan (event types), scan (an EXECUTED job), and reconciliation (coverage)
    // are done → 3 of 5.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
      }),
    })

    expect(screen.getByText('3 of 5')).toBeInTheDocument()
    // Done steps are labelled, incomplete ones are not.
    expect(screen.getAllByText('Done')).toHaveLength(3)
  })

  it('does NOT count a seeded scan config with no executed job as "Run a scan"', () => {
    // scan_count > 0 (a seeded ScanConfig) but no job has ever run — the scan
    // step must stay incomplete. plan + reconciliation are the only done steps.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        scan_count: 3,
        latest_scan_job: null,
        implemented_event_count: 3,
      }),
    })

    expect(screen.getByText('2 of 5')).toBeInTheDocument()
  })

  it('does not count a merely-queued (pending) job as an executed scan', () => {
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        scan_count: 1,
        latest_scan_job: executedJob('pending'),
        implemented_event_count: 3,
      }),
    })

    // plan + reconciliation done; the pending job doesn't tick "Run a scan".
    expect(screen.getByText('2 of 5')).toBeInTheDocument()
  })

  it('counts a connected data source toward completion', () => {
    renderChecklist({ summary: makeSummary(), sourceCount: 1 })

    expect(screen.getByText('1 of 5')).toBeInTheDocument()
  })

  // --- Role-awareness (tripl-yfsj.4) --------------------------------------
  // Connecting a data source is owner-only. A self-registered / invited user is
  // an editor, so for a non-owner that step must be discoverable-but-non-blocking
  // rather than a silent dead-end that keeps the checklist from ever finishing.

  it('still counts the data-source step for owners and shows no owner-only flag', () => {
    renderChecklist({ role: 'owner', summary: makeSummary({ event_type_count: 4 }) })

    // plan done → 1 of 5; the owner can action every step.
    expect(screen.getByText('1 of 5')).toBeInTheDocument()
    expect(screen.queryByText('Owner only')).not.toBeInTheDocument()
  })

  it('shows the owner-only data-source step but excludes it from an editor’s progress', () => {
    renderChecklist({ role: 'editor', summary: makeSummary({ event_type_count: 4 }) })

    // plan is done → 1 of 4: the source step is not one of the counted four.
    expect(screen.getByText('1 of 4')).toBeInTheDocument()
    // Still discoverable: the row is rendered, links to the (read-only) list,
    // and is flagged owner-only with an ask-an-owner hint.
    expect(screen.getByRole('link', { name: /Connect a data source/ })).toHaveAttribute(
      'href',
      '/settings/data-sources',
    )
    expect(screen.getByText('Owner only')).toBeInTheDocument()
    expect(screen.getByText(/ask an owner/i)).toBeInTheDocument()
  })

  it('treats an anonymous (no-user) context as a non-owner', () => {
    renderChecklist({ role: null, summary: makeSummary({ event_type_count: 4 }) })

    expect(screen.getByText('1 of 4')).toBeInTheDocument()
    expect(screen.getByText('Owner only')).toBeInTheDocument()
  })

  it('lets an editor complete the checklist without connecting a data source', () => {
    // All four editor-actionable steps are done; no real source (an owner's job).
    // The checklist reaches done and hides instead of being stuck forever.
    const { container } = renderChecklist({
      role: 'editor',
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
        alert_destination_count: 1,
        alert_rule_count: 1,
      }),
      sourceCount: 0,
    })

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(screen.queryByText(/Almost set up/)).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('names the real remaining step (not the owner-only source) in an editor’s compact bar', () => {
    renderChecklist({
      role: 'editor',
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
      }),
      sourceCount: 0,
    })

    // plan + scan + reconcile done → 3 of 4 for an editor; alerting is the one
    // remaining actionable step, and the owner-only source is never named here.
    expect(screen.getByText('3 of 4')).toBeInTheDocument()
    expect(screen.getByText(/1 step left: Set up alerting/)).toBeInTheDocument()
  })

  it('shows an already-connected source as done for an editor, still out of 4', () => {
    // An owner has connected a source (sourceCount > 0): the step is genuinely
    // done. It renders as Done but stays outside the editor's 4-step tally.
    renderChecklist({
      role: 'editor',
      summary: makeSummary({ event_type_count: 4 }),
      sourceCount: 1,
    })

    expect(screen.getByText('1 of 4')).toBeInTheDocument()
    expect(screen.queryByText('Owner only')).not.toBeInTheDocument()
    // Both plan and the connected source render a Done badge.
    expect(screen.getAllByText('Done')).toHaveLength(2)
  })

  it('collapses to a compact bar once all but the last step are done (fix #13)', () => {
    // 4 of 5 done — everything except alerting → slim bar, not the full card.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
      }),
      sourceCount: 1,
    })

    expect(screen.getByText('4 of 5')).toBeInTheDocument()
    // The tall card header and its step rows are hidden until expanded.
    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(screen.queryByText('Define your plan')).not.toBeInTheDocument()

    // Expanding reveals the full multi-row checklist.
    fireEvent.click(screen.getByRole('button', { name: /show steps/i }))
    expect(screen.getByText('Get started')).toBeInTheDocument()
    expect(screen.getByText('Set up alerting')).toBeInTheDocument()
  })

  it('can still be dismissed from the compact bar (fix #13)', () => {
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
      }),
      sourceCount: 1,
    })

    expect(screen.getByText('4 of 5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByText('4 of 5')).not.toBeInTheDocument()
    expect(localStorage.getItem('tripl-onboarding-dismissed:demo')).toBe('1')
  })

  it('auto-hides once every step is complete', () => {
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
        alert_destination_count: 1,
        alert_rule_count: 1,
      }),
      sourceCount: 1,
    })

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
  })

  // --- "Set up alerting" needs a ROUTE, not just a channel (tripl-jfm3.81) ---
  // A destination with no enabled rule delivers nothing: rules decide which
  // signals matter and where they go. Ticking the step on the destination alone
  // let a user stop half-way and read a complete checklist over an alerting
  // setup that could never reach anyone.

  it('does not complete "Set up alerting" on a destination with no rule', () => {
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
        alert_destination_count: 1,
        alert_rule_count: 0,
      }),
      sourceCount: 1,
    })

    // Four of five: the destination exists but routes nothing, so the card
    // still points at alerting instead of vanishing at "5 of 5".
    expect(screen.getByText('4 of 5')).toBeInTheDocument()
    expect(screen.getByText(/1 step left: Set up alerting/)).toBeInTheDocument()
  })

  it('completes "Set up alerting" once a rule is bound to the destination', () => {
    const { container } = renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
        alert_destination_count: 1,
        alert_rule_count: 1,
      }),
      sourceCount: 1,
    })

    expect(container).toBeEmptyDOMElement()
  })

  it('does not complete alerting on a rule with no destination', () => {
    // Defensive: the two counters are independent on the wire, and a rule
    // cannot route without a channel any more than the reverse.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
        alert_destination_count: 0,
        alert_rule_count: 1,
      }),
      sourceCount: 1,
    })

    expect(screen.getByText('4 of 5')).toBeInTheDocument()
  })

  it('tells the user a RULE is what routes anomalies', () => {
    renderChecklist({ summary: makeSummary({ event_type_count: 4 }), sourceCount: 1 })

    // The old hint ("Add a destination so anomalies reach your team.") taught
    // the same wrong model the done-check encoded.
    expect(screen.getByText(/the rule is what routes anomalies/i)).toBeInTheDocument()
    expect(screen.queryByText(/Add a destination so anomalies reach your team/)).toBeNull()
  })

  it('auto-hides for an established project when only an optional step remains (tripl-7l83.12)', () => {
    // windy-android-shaped: high coverage, real scans and sources, but alerting
    // was deliberately never wired up. The core loop is set up, so a "4 of 5"
    // that can never reach 5 should disappear, not become permanent chrome.
    const { container } = renderChecklist({
      summary: makeSummary({
        event_type_count: 12,
        active_event_count: 724,
        implemented_event_count: 673, // ~93% coverage
        latest_scan_job: executedJob(),
        // alert_destination_count stays 0 — the skipped optional step
      }),
      sourceCount: 1,
    })

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(screen.queryByText(/Almost set up/)).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps showing for a young low-coverage project even at 4 of 5', () => {
    // Same optional step outstanding, but coverage is far below the mature
    // threshold — a genuinely new project, so the guidance stays visible.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 12,
        active_event_count: 724,
        implemented_event_count: 5, // ~0.7% coverage
        latest_scan_job: executedJob(),
      }),
      sourceCount: 1,
    })

    expect(screen.getByText('4 of 5')).toBeInTheDocument()
    expect(screen.getByText(/Almost set up/)).toBeInTheDocument()
  })

  it('names the single remaining step inline in the compact bar (tripl-7l83.12)', () => {
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
      }),
      sourceCount: 1,
    })

    expect(screen.getByText(/1 step left: Set up alerting/)).toBeInTheDocument()
  })

  it('renders nothing for a demo project even when a step is outstanding (tripl-q7i1.7)', () => {
    // A demo's only source is synthetic (excluded from sourceCount), so the
    // "Connect a data source" step could never complete — this otherwise yields
    // "4 of 5" and a permanent "Almost set up" bar. Demos own their onboarding
    // (DemoWelcomePanel + coach), so the checklist must render nothing.
    const { container } = renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
      }),
      sourceCount: 1,
      isDemo: true,
    })

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(screen.queryByText(/Almost set up/)).not.toBeInTheDocument()
    expect(screen.queryByText('Connect a data source')).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('still shows the compact bar for a non-demo project with the same "4 of 5" state', () => {
    // Regression guard: the isDemo hide must not swallow real projects. The same
    // summary that a demo hides renders the "Almost set up" bar when not a demo.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        latest_scan_job: executedJob(),
        implemented_event_count: 3,
      }),
      sourceCount: 1,
      isDemo: false,
    })

    expect(screen.getByText('4 of 5')).toBeInTheDocument()
    expect(screen.getByText(/Almost set up/)).toBeInTheDocument()
  })

  it('renders nothing while the summary is still loading', () => {
    const { container } = renderChecklist({ summary: undefined })

    expect(container).toBeEmptyDOMElement()
  })

  it('is dismissible and persists the dismissal per project', () => {
    renderChecklist({ summary: makeSummary() })

    expect(screen.getByText('Get started')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(localStorage.getItem('tripl-onboarding-dismissed:demo')).toBe('1')
  })

  it('stays hidden on a later visit when already dismissed', () => {
    localStorage.setItem('tripl-onboarding-dismissed:demo', '1')
    renderChecklist({ summary: makeSummary() })

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
  })

  it('keeps the dismissal across a full remount (localStorage persistence)', () => {
    // Dismiss, unmount the whole tree, then mount a fresh instance (e.g. the user
    // navigates away and back). The X must be remembered, not reset on remount.
    const first = renderChecklist({ summary: makeSummary() })
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    first.unmount()

    renderChecklist({ summary: makeSummary() })

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
    expect(localStorage.getItem('tripl-onboarding-dismissed:demo')).toBe('1')
  })
})

describe('countRealSources', () => {
  it('excludes synthetic demo sources from the real-source count', () => {
    const sources = [
      { is_synthetic: true },
      { is_synthetic: false },
      { is_synthetic: false },
    ]
    // The demo's synthetic warehouse must NOT count as connecting a real source.
    expect(countRealSources(sources)).toBe(2)
  })

  it('treats a source with no synthetic flag as real', () => {
    expect(countRealSources([{}, { is_synthetic: false }])).toBe(2)
  })

  it('returns zero for a demo whose only source is synthetic', () => {
    expect(countRealSources([{ is_synthetic: true }])).toBe(0)
  })
})
