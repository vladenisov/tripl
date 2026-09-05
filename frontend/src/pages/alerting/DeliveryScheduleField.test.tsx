import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { DeliveryScheduleField } from './DeliveryScheduleField'

/**
 * The field edits ONE value — the cron expression that ships to the API — so
 * the harness holds exactly that and asserts on it. Anything else would test a
 * shape the wire never sees.
 *
 * Mode switching goes through a Radix Select, which jsdom cannot drive without
 * a pointer-events shim; the mode transitions themselves are covered
 * exhaustively by ./deliverySchedule.test.ts against the same pure functions
 * this component calls. What is asserted here is the wiring: what a stored
 * expression renders as, and what editing the inputs writes back.
 */
function Harness({ initial = '' }: { initial?: string }) {
  const [cron, setCron] = useState(initial)
  return (
    <>
      <DeliveryScheduleField
        value={cron}
        onChange={setCron}
        projectTimezone="Europe/Moscow"
        nextDigestAt={null}
      />
      <output data-testid="cron">{cron === '' ? '(immediate)' : cron}</output>
    </>
  )
}

describe('DeliveryScheduleField', () => {
  it('starts on immediate and says so, because that is the unchanged default', () => {
    render(<Harness />)

    expect(screen.getByTestId('cron')).toHaveTextContent('(immediate)')
    expect(screen.getByText(/sent as soon as a collection finds something/i)).toBeInTheDocument()
  })

  it('shows a stored daily expression as a time, and names the project timezone', () => {
    render(<Harness initial="0 9 * * *" />)

    expect(screen.getByLabelText('Time of day')).toHaveValue('09:00')
    // The zone has to be on screen: "09:00" is meaningless without it, and
    // reading it as local time is the mistake this copy exists to prevent.
    expect(screen.getByText(/Europe\/Moscow/)).toBeInTheDocument()
    expect(screen.getByText(/Daily at 09:00/)).toBeInTheDocument()
  })

  it('shows a multi-time expression as the list that produced it', () => {
    render(<Harness initial="0 9,18 * * *" />)

    expect(screen.getByLabelText('Times of day')).toHaveValue('09:00, 18:00')
    expect(screen.getByText(/Every day at 09:00, 18:00/)).toBeInTheDocument()
  })

  it('keeps an expression the presets cannot express in the cron box, verbatim', () => {
    render(<Harness initial="*/5 9-17 * * 1-5" />)

    // Silently rewriting a hand-written cron into a near-miss preset would
    // change when someone is paged without telling them.
    expect(screen.getByLabelText('Cron expression')).toHaveValue('*/5 9-17 * * 1-5')
    expect(screen.getByTestId('cron')).toHaveTextContent('*/5 9-17 * * 1-5')
  })

  it('writes an edited time straight back as a cron expression', () => {
    render(<Harness initial="0 9 * * *" />)

    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '18:30' } })

    expect(screen.getByTestId('cron')).toHaveTextContent('30 18 * * *')
  })

  it('flags a malformed time instead of writing a schedule nobody asked for', () => {
    render(<Harness initial="0 9 * * *" />)

    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '9am' } })

    expect(screen.getByText(/Enter a time as HH:MM/)).toBeInTheDocument()
  })

  it('flags a cron expression that is not five fields', () => {
    render(<Harness initial="*/5 9-17 * * 1-5" />)

    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '@daily' } })

    expect(screen.getByText(/5 fields/)).toBeInTheDocument()
  })
})
