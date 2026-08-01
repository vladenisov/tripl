import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/api/client'
import { eventTypesApi } from '@/api/eventTypes'
import { EventDriftBadge } from './EventDriftBadge'

vi.mock('@/api/eventTypes', () => ({
  eventTypesApi: {
    listDrifts: vi.fn(),
    applyDriftAction: vi.fn(),
  },
}))

const DRIFT = {
  id: 'drift-1',
  event_type_id: 'et-1',
  scan_config_id: null,
  field_name: 'action',
  drift_type: 'missing_field' as const,
  observed_type: null,
  declared_type: 'string',
  sample_value: null,
  status: 'open' as const,
  resolution_note: null,
  snoozed_until: null,
  resolved_at: null,
  resolved_by: null,
  detected_at: '2026-07-26T00:00:00Z',
}

// The real 409 from services/schema_drift_service._reject_if_name_format_needs.
// api/client.ts puts a plain-string `detail` straight into ApiError.message, so
// the popover can render it with no parsing.
const CONFLICT_DETAIL =
  "Cannot accept this drift: the field 'action' is used by the event name format " +
  "of 1 scan config(s): 'Old events (iOS)' ({action}). Accepting would delete the " +
  'field and every scan would then fail with \'the event name format references ' +
  "unknown keys'. Edit the scan's Event name format so it no longer references " +
  'this column, then accept the drift.'

function renderBadge() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <EventDriftBadge slug="demo" eventTypeId="et-1" count={1} />
    </QueryClientProvider>,
  )
}

async function openPopoverAndAccept() {
  fireEvent.click(screen.getByRole('button', { name: '1 schema drift on this event type' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('EventDriftBadge', () => {
  it('renders the backend 409 verbatim when the accept is blocked', async () => {
    // Without this the guard is invisible: the button just stops pending and the
    // drift stays open with no explanation (tripl-3mmh).
    vi.mocked(eventTypesApi.listDrifts).mockResolvedValue({ items: [DRIFT], total: 1 })
    vi.mocked(eventTypesApi.applyDriftAction).mockRejectedValue(
      new ApiError(CONFLICT_DETAIL, 409),
    )

    renderBadge()
    await openPopoverAndAccept()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('is used by the event name format')
    expect(alert).toHaveTextContent('Event name format')
  })

  it('does not greet the next popover open with the previous 409', async () => {
    // The `onOpenChange` reset in EventDriftBadge is the only thing stopping
    // this: react-query keeps a mutation's error until it is reset or replaced,
    // and Radix remounts the content on every open, so a failure from the last
    // visit renders again next to a drift it may have nothing to do with.
    vi.mocked(eventTypesApi.listDrifts).mockResolvedValue({ items: [DRIFT], total: 1 })
    vi.mocked(eventTypesApi.applyDriftAction).mockRejectedValue(
      new ApiError(CONFLICT_DETAIL, 409),
    )

    renderBadge()
    await openPopoverAndAccept()
    await screen.findByRole('alert')

    const trigger = screen.getByRole('button', { name: '1 schema drift on this event type' })
    fireEvent.click(trigger) // close
    fireEvent.click(trigger) // reopen

    await screen.findByRole('button', { name: 'Accept' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows no alert when the accept succeeds', async () => {
    vi.mocked(eventTypesApi.listDrifts).mockResolvedValue({ items: [DRIFT], total: 1 })
    vi.mocked(eventTypesApi.applyDriftAction).mockResolvedValue({
      ...DRIFT,
      status: 'accepted',
    })

    renderBadge()
    await openPopoverAndAccept()

    await waitFor(() =>
      expect(eventTypesApi.applyDriftAction).toHaveBeenCalledWith('demo', 'drift-1', {
        action: 'accept',
      }),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
