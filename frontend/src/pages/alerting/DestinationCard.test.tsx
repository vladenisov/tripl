import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { alertingApi } from '@/api/alerting'
import type { AlertDestination, AlertRule } from '@/types'

import { DestinationCard } from './DestinationCard'

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-1',
    destination_id: 'dest-1',
    scan_config_id: null,
    name: 'Prod drops',
    enabled: true,
    include_project_total: true,
    include_event_types: false,
    include_events: false,
    include_schema_drifts: false,
    include_distribution_drifts: false,
    include_release_regressions: false,
    include_variable_value_drifts: false,
    include_metrics: false,
    notify_on_spike: false,
    notify_on_drop: true,
    ai_explanation_enabled: false,
    min_percent_delta: 100,
    min_absolute_delta: 0,
    min_expected_count: 0,
    cooldown_minutes: 360,
    message_template: null,
    items_template: null,
    message_format: 'plain',
    filters: [],
    muted: false,
    muted_until: null,
    total_deliveries: 115,
    incident_count: 57,
    last_delivery_at: '2026-08-12T09:00:00Z',
    last_delivery_status: 'sent',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function makeDestination(overrides: Partial<AlertDestination> = {}): AlertDestination {
  return {
    id: 'dest-1',
    project_id: 'proj-1',
    type: 'telegram',
    name: 'TG',
    enabled: true,
    webhook_set: false,
    bot_token_set: true,
    chat_id: '-1002233445566',
    target_url_set: false,
    webhook_header_name: null,
    email_recipients: null,
    email_from_address: null,
    email_subject_template: null,
    jira_base_url: null,
    jira_auth_email: null,
    jira_api_token_set: false,
    jira_project_key: null,
    jira_issue_type: null,
    linear_api_key_set: false,
    linear_team_id: null,
    linear_state_id: null,
    linear_label_ids: null,
    is_local: false,
    delivery_count: 115,
    incident_count: 57,
    rules: [makeRule()],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function renderCard(
  destination: AlertDestination = makeDestination(),
  canWrite = true,
  // Guided setup's step 3 hands one card the instruction to open its own rule
  // form and expects to be told when it has been acted on (tripl-oxkt.15).
  guidedSetup: { autoOpenRule?: boolean; onAutoOpenRuleConsumed?: () => void } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DestinationCard
          slug="windy-ios"
          destination={destination}
          eventTypes={[]}
          scans={[]}
          canWrite={canWrite}
          onEditDestination={() => {}}
          autoOpenRule={guidedSetup.autoOpenRule}
          onAutoOpenRuleConsumed={guidedSetup.onAutoOpenRuleConsumed}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DestinationCard test send', () => {
  it('reports a delivered probe, because a stored token is not a working one', async () => {
    const test = vi.spyOn(alertingApi, 'testDestination').mockResolvedValue({
      ok: true,
      error: null,
      sent_at: '2026-08-12T12:00:00Z',
    })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Send a test message through TG' }))

    expect(await screen.findByText(/Test message reached the channel at/)).toBeInTheDocument()
    expect(test).toHaveBeenCalledWith('windy-ios', 'dest-1')
  })

  it('renders a channel refusal as the answer, not as a crash', async () => {
    // The route answers 200 with `ok: false` — a revoked bot token IS what the
    // button was pressed to find out, so it must not be styled as a server
    // fault the operator can do nothing about (tripl-oxkt.17).
    vi.spyOn(alertingApi, 'testDestination').mockResolvedValue({
      ok: false,
      error: 'Forbidden: bot was blocked by the user',
      sent_at: null,
    })
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Send a test message through TG' }))

    const refusal = await screen.findByText(/bot was blocked by the user/)
    expect(refusal).toHaveAttribute('role', 'status')
  })

  it('names the transport failure when the request never reached the server', async () => {
    vi.spyOn(alertingApi, 'testDestination').mockRejectedValue(new Error('Network down'))
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Send a test message through TG' }))

    const failure = await screen.findByRole('alert')
    expect(failure).toHaveTextContent('Test send failed: Network down')
  })
})

describe('DestinationCard delete confirms', () => {
  it('states what the cascade destroys instead of asking Delete "TG"?', async () => {
    // `AlertDelivery.rule_id` is ON DELETE CASCADE and the inbox INNER JOINs
    // through it, so this one button took 115 deliveries and 57 incidents —
    // with their notes and mutes — behind a confirm that named none of it
    // (tripl-oxkt.13).
    const remove = vi.spyOn(alertingApi, 'deleteRule').mockResolvedValue(undefined)
    renderCard()

    fireEvent.click(screen.getByRole('button', { name: 'Delete rule Prod drops' }))

    expect(
      await screen.findByText(
        /Delete "Prod drops"\? This also deletes 115 deliveries and 57 incidents/,
      ),
    ).toBeInTheDocument()
    expect(remove).not.toHaveBeenCalled()
  })

  it('says plainly that a rule which never delivered loses no history', async () => {
    renderCard(makeDestination({
      rules: [makeRule({ total_deliveries: 0, incident_count: 0, last_delivery_at: null, last_delivery_status: null })],
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Delete rule Prod drops' }))

    expect(
      await screen.findByText(/It has never delivered, so no history is lost\./),
    ).toBeInTheDocument()
  })
})

describe('DestinationCard guided-setup handoff (tripl-oxkt.15)', () => {
  it('opens the rule form by itself on the destination just created', () => {
    // The checklist promises "a rule prefilled on the new destination"; the card
    // had no channel for that at all — its rule dialog opened on click only.
    renderCard(makeDestination(), true, { autoOpenRule: true })

    expect(screen.getByText('New Alert Rule')).toBeInTheDocument()
  })

  it('stays closed on every ordinary visit', () => {
    renderCard()

    expect(screen.queryByText('New Alert Rule')).toBeNull()
  })

  it('reports the instruction spent, and does not re-open on the next render', () => {
    const consumed = vi.fn()
    renderCard(makeDestination(), true, { autoOpenRule: true, onAutoOpenRuleConsumed: consumed })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText('New Alert Rule')).toBeNull()
    // The page clears its own state off this callback: the prop is still `true`
    // here, so a card that never reported back would be re-opened by the next
    // mount of this section.
    expect(consumed).toHaveBeenCalled()
  })
})

describe('DestinationCard delivery health', () => {
  it('shows the destination and rule traffic the card used to hide', () => {
    renderCard()

    expect(screen.getByText('1 rule · 115 deliveries · 57 incidents')).toBeInTheDocument()
    expect(screen.getByText('115 deliveries · 57 incidents')).toBeInTheDocument()
    expect(screen.getByText(/^last /)).toBeInTheDocument()
    expect(screen.getByText('sent')).toBeInTheDocument()
  })

  it('distinguishes "never delivered" from "delivered a while ago"', () => {
    renderCard(makeDestination({
      delivery_count: 0,
      incident_count: 0,
      rules: [makeRule({ total_deliveries: 0, incident_count: 0, last_delivery_at: null, last_delivery_status: null })],
    }))

    expect(screen.getByText('Never delivered')).toBeInTheDocument()
    expect(screen.queryByText(/^last /)).toBeNull()
  })
})

describe('DestinationCard rule state', () => {
  it('shows the mute this card used to contradict, and links to the surface that owns it', () => {
    renderCard(makeDestination({
      rules: [makeRule({ muted: true, muted_until: '2026-08-19T00:00:00Z' })],
    }))

    expect(screen.getByText(/^muted until /)).toBeInTheDocument()
    // The control is not duplicated here: one switch in two places is how the
    // two screens started disagreeing in the first place (tripl-oxkt.18).
    expect(screen.getByRole('link', { name: 'Change mute →' })).toHaveAttribute(
      'href',
      '/p/windy-ios/monitors/rule-1',
    )
  })

  it('gives every setting its own label instead of one run-on line', () => {
    renderCard()

    // "Scan: all scans Scopes: total Direction: down Cooldown: 6h Min %: 100 …"
    // was one wrapped paragraph in which no single setting could be found.
    expect(screen.getByText('Cooldown')).toBeInTheDocument()
    expect(screen.getByText('6h')).toBeInTheDocument()
    expect(screen.getByText('Min expected')).toBeInTheDocument()
  })

  it('labels replay, the highest-value control on the page', () => {
    renderCard()

    const replay = screen.getByRole('button', { name: 'Replay Prod drops' })
    expect(replay).toHaveTextContent('Replay')
  })

  it('routes the enable switch through a mutation so a failure is not silent', async () => {
    const update = vi.spyOn(alertingApi, 'updateRule').mockResolvedValue(makeRule({ enabled: false }))
    renderCard()

    fireEvent.click(screen.getByRole('switch', { name: 'Toggle Prod drops' }))

    // Awaited: `mutate` hands the call to react-query, which runs the mutation
    // fn off the click's synchronous path.
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('windy-ios', 'dest-1', 'rule-1', { enabled: false }),
    )
  })

  it('leaves the switch showing the server value when the write is rejected', async () => {
    // The rejected write must not repaint the switch: `checked` is bound to the
    // rule the server sent, so a 403 leaves it exactly where it was rather than
    // flipping and silently reverting (tripl-oxkt.9).
    vi.spyOn(alertingApi, 'updateRule').mockRejectedValue(new Error('Editor role required'))
    renderCard()

    const toggle = screen.getByRole('switch', { name: 'Toggle Prod drops' })
    fireEvent.click(toggle)

    await waitFor(() => expect(toggle).toBeChecked())
  })
})

describe('DestinationCard viewer gating (tripl-oxkt.9)', () => {
  // Every one of these is an editor-only endpoint (deps.py `require_editor`),
  // and each of them used to render fully enabled for a viewer whose click came
  // straight back as a 403.
  const WRITE_BUTTONS = [
    'Send a test message through TG',
    'Edit destination TG',
    'Add Rule',
    'Edit rule Prod drops',
    'Delete rule Prod drops',
  ]
  const WRITE_SWITCHES = ['Toggle TG', 'Toggle Prod drops']

  it('offers an editor every write control', () => {
    renderCard()

    for (const name of WRITE_BUTTONS) {
      expect(screen.getByRole('button', { name })).toBeEnabled()
    }
    for (const name of WRITE_SWITCHES) {
      expect(screen.getByRole('switch', { name })).toBeEnabled()
    }
  })

  it('offers a viewer none of them', () => {
    renderCard(makeDestination(), false)

    for (const name of WRITE_BUTTONS) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    for (const name of WRITE_SWITCHES) {
      expect(screen.queryByRole('switch', { name })).toBeNull()
    }
  })

  it('keeps replay, which the API does not gate because it saves nothing', () => {
    // The one control in the cluster with no EditorUserDep on its route: asking
    // "would a stricter threshold have cut this noise" changes nothing.
    renderCard(makeDestination(), false)

    expect(screen.getByRole('button', { name: 'Replay Prod drops' })).toBeEnabled()
  })

  it('keeps every fact the card was reporting', () => {
    renderCard(makeDestination(), false)

    expect(screen.getByText('1 rule · 115 deliveries · 57 incidents')).toBeInTheDocument()
    expect(screen.getByText('115 deliveries · 57 incidents')).toBeInTheDocument()
    expect(screen.getByText('Cooldown')).toBeInTheDocument()
  })
})
