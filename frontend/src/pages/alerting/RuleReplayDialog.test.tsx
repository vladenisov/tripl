import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { alertingApi } from '@/api/alerting'
import type { AlertRule, AlertRuleSimulateResponse } from '@/types'
import { RuleReplayDialog } from './RuleReplayDialog'

const LONG_SCOPE = 'a9ed99c1-ca7f-4704-a8b6-d836c44b66e2'
const LONG_MESSAGE = `[tripl] 3 alerts\nProject delivery via demo sink\n${'unbroken-preview-token'.repeat(24)}`

const RULE: AlertRule = {
  id: 'rule-1',
  destination_id: 'destination-1',
  name: 'Test',
  enabled: true,
  include_project_total: true,
  include_event_types: true,
  include_events: true,
  include_schema_drifts: false,
  include_distribution_drifts: false,
  include_release_regressions: false,
  include_variable_value_drifts: false,
  notify_on_spike: true,
  notify_on_drop: true,
  ai_explanation_enabled: false,
  min_percent_delta: 20,
  min_absolute_delta: 10,
  min_expected_count: 100,
  cooldown_minutes: 1440,
  message_template: null,
  items_template: null,
  message_format: 'plain',
  filters: [],
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
}

const RESULT: AlertRuleSimulateResponse = {
  rule_id: RULE.id,
  rule_name: RULE.name,
  days: 7,
  window_from: '2026-07-12T10:00:00Z',
  window_to: '2026-07-19T10:00:00Z',
  anomalies_considered: 6,
  matched_before_cooldown: 3,
  noisy: false,
  cooldown_minutes_used: 1440,
  cooldown_minutes_saved: 1440,
  rendered_message: LONG_MESSAGE,
  firings: [
    {
      anomaly_id: 'anomaly-1',
      scope_type: 'project_total',
      scope_ref: LONG_SCOPE,
      scope_name: LONG_SCOPE,
      event_type_id: null,
      event_id: null,
      drift_field: null,
      drift_type: null,
      sample_value: null,
      bucket: '2026-07-19T10:00:00Z',
      direction: 'spike',
      actual_count: 5780,
      expected_count: 3529,
      absolute_delta: 2251,
      percent_delta: 63.8,
      rendered_item: null,
    },
  ],
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RuleReplayDialog
        open
        onOpenChange={() => {}}
        slug="demo"
        destinationId="destination-1"
        rule={RULE}
      />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RuleReplayDialog responsive results', () => {
  it('confines wide replay data to the result viewport without widening the dialog', async () => {
    vi.spyOn(alertingApi, 'simulateRule').mockResolvedValue(RESULT)
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }))

    const scope = await screen.findByText(LONG_SCOPE)
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('w-[calc(100vw-2rem)]', 'max-w-4xl', 'overflow-hidden')

    const firingRegion = within(dialog).getByRole('region', { name: 'Replay firings' })
    expect(firingRegion).toHaveAttribute('tabindex', '0')

    const table = scope.closest('table')
    expect(table).not.toBeNull()
    expect(table).toHaveClass('min-w-[720px]', 'table-fixed')
    expect(table?.parentElement).toBe(firingRegion)
    expect(firingRegion).toHaveClass('min-w-0', 'max-w-full', 'overflow-x-auto')
    expect(within(table as HTMLTableElement).getByText(/Jul 19, 2026/)).toHaveClass(
      'whitespace-nowrap',
    )

    const preview = dialog.querySelector('pre')
    expect(preview?.textContent).toContain(LONG_MESSAGE)
    expect(preview).toHaveClass('min-w-0', 'max-w-full', '[overflow-wrap:anywhere]')
    const footerClose = screen
      .getAllByRole('button', { name: 'Close' })
      .find((button) => button.getAttribute('data-slot') === 'button')
    expect(footerClose).toBeInTheDocument()
    expect(footerClose?.closest('[data-slot="dialog-footer"]')).toHaveClass('shrink-0')
  })
})
