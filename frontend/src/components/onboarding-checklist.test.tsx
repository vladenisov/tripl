import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectSummary } from '@/types'
import { OnboardingChecklist } from './onboarding-checklist'

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
    monitoring_signal_count: 0,
    firing_monitor_count: 0,
    failing_scan_config_count: 0,
    latest_scan_job: null,
    latest_signal: null,
    ...overrides,
  }
}

function renderChecklist(props: {
  summary: ProjectSummary | undefined
  sourceCount?: number
  slug?: string
}) {
  return render(
    <MemoryRouter>
      <OnboardingChecklist
        slug={props.slug ?? 'demo'}
        summary={props.summary}
        sourceCount={props.sourceCount ?? 0}
      />
    </MemoryRouter>,
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
      [/Run a scan/, '/p/demo/settings/scans'],
      [/Review reconciliation/, '/p/demo/reconciliation'],
      [/Set up alerting/, '/p/demo/settings/alerting'],
    ]
    for (const [name, href] of expected) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href)
    }
  })

  it('auto-derives the completed count from project state', () => {
    // plan (event types), scan, and reconciliation (coverage) are done → 3 of 5.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        scan_count: 2,
        implemented_event_count: 3,
      }),
    })

    expect(screen.getByText('3 of 5')).toBeInTheDocument()
    // Done steps are labelled, incomplete ones are not.
    expect(screen.getAllByText('Done')).toHaveLength(3)
  })

  it('counts a connected data source toward completion', () => {
    renderChecklist({ summary: makeSummary(), sourceCount: 1 })

    expect(screen.getByText('1 of 5')).toBeInTheDocument()
  })

  it('collapses to a compact bar once all but the last step are done (fix #13)', () => {
    // 4 of 5 done — everything except alerting → slim bar, not the full card.
    renderChecklist({
      summary: makeSummary({
        event_type_count: 4,
        scan_count: 2,
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
        scan_count: 2,
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
        scan_count: 2,
        implemented_event_count: 3,
        alert_destination_count: 1,
      }),
      sourceCount: 1,
    })

    expect(screen.queryByText('Get started')).not.toBeInTheDocument()
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
        scan_count: 3,
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
        scan_count: 3,
      }),
      sourceCount: 1,
    })

    expect(screen.getByText('4 of 5')).toBeInTheDocument()
    expect(screen.getByText(/Almost set up/)).toBeInTheDocument()
  })

  it('names the single remaining step inline in the compact bar (tripl-7l83.12)', () => {
    renderChecklist({
      summary: makeSummary({ event_type_count: 4, scan_count: 2, implemented_event_count: 3 }),
      sourceCount: 1,
    })

    expect(screen.getByText(/1 step left: Set up alerting/)).toBeInTheDocument()
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
