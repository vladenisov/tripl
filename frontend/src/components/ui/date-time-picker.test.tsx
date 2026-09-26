import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { expectNoAxeViolations } from '@/test/axe'
import { DatePicker, DateTimePicker } from './date-time-picker'

function renderPicker(initial = '2026-01-14T09:30') {
  const onChange = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return (
      <DateTimePicker
        label="Date and time"
        value={value}
        onChange={next => {
          onChange(next)
          setValue(next)
        }}
      />
    )
  }
  render(<Harness />)
  return { onChange }
}

function openCalendar() {
  fireEvent.click(screen.getByRole('button', { name: /^Date and time, date: / }))
  return screen.findByRole('grid', { name: 'January 2026' })
}

describe('DateTimePicker', () => {
  it('names its date button and time field after the label, and shows the value', () => {
    renderPicker()

    expect(screen.getByRole('group', { name: 'Date and time' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Date and time, date: / })).toHaveTextContent('Jan 14, 2026')
    expect(screen.getByLabelText('Date and time, time')).toHaveValue('09:30')
  })

  it('opens on the chosen day, focused and selected', async () => {
    renderPicker()

    const grid = await openCalendar()
    const day = within(grid).getByRole('button', { name: 'Wednesday, January 14, 2026' })
    await waitFor(() => expect(day).toHaveFocus())
    // The <td> is a gridcell by virtue of its role="grid" table, so it carries
    // no explicit role. Testing Library does not derive that implicit role, so
    // reach the cell through the DOM; the axe test below checks the semantics.
    expect(day.closest('td')).toHaveAttribute('aria-selected', 'true')
    expect(day).toHaveAttribute('tabindex', '0')
  })

  it('picks a day with the mouse and keeps the time', async () => {
    const { onChange } = renderPicker()

    const grid = await openCalendar()
    fireEvent.click(within(grid).getByRole('button', { name: 'Tuesday, January 20, 2026' }))

    expect(onChange).toHaveBeenLastCalledWith('2026-01-20T09:30')
    await waitFor(() => expect(screen.queryByRole('grid')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Date and time, date: / })).toHaveTextContent('Jan 20, 2026')
  })

  it('moves by day and week with the arrow keys, and by month with Page Down', async () => {
    renderPicker()

    const grid = await openCalendar()
    await waitFor(() =>
      expect(within(grid).getByRole('button', { name: 'Wednesday, January 14, 2026' })).toHaveFocus(),
    )

    fireEvent.keyDown(grid, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Thursday, January 15, 2026' })).toHaveFocus(),
    )
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Thursday, January 22, 2026' })).toHaveFocus(),
    )
    fireEvent.keyDown(grid, { key: 'Home' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Monday, January 19, 2026' })).toHaveFocus(),
    )

    fireEvent.keyDown(grid, { key: 'PageDown' })
    const february = await screen.findByRole('grid', { name: 'February 2026' })
    await waitFor(() =>
      expect(within(february).getByRole('button', { name: 'Thursday, February 19, 2026' })).toHaveFocus(),
    )
  })

  it('changes month with the previous / next buttons', async () => {
    renderPicker()

    await openCalendar()
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    expect(await screen.findByRole('grid', { name: 'February 2026' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    expect(await screen.findByRole('grid', { name: 'December 2025' })).toBeInTheDocument()
  })

  it('changes the time and keeps the day', () => {
    const { onChange } = renderPicker()

    fireEvent.change(screen.getByLabelText('Date and time, time'), { target: { value: '17:05' } })

    expect(onChange).toHaveBeenLastCalledWith('2026-01-14T17:05')
  })

  it('asks for a date when it has none', () => {
    renderPicker('')

    expect(screen.getByRole('button', { name: /^Date and time, date: / })).toHaveTextContent('Pick a date')
  })

  it('has no axe violations, open or closed', async () => {
    renderPicker()
    await expectNoAxeViolations(document.body)

    await openCalendar()
    await expectNoAxeViolations(document.body)
  })
})

describe('DatePicker (date only)', () => {
  function renderDatePicker(initial = '2026-01-14', bounds: { min?: string; max?: string } = {}) {
    const onChange = vi.fn()
    function Harness() {
      const [value, setValue] = useState(initial)
      return (
        <DatePicker
          label="From"
          value={value}
          {...bounds}
          onChange={next => {
            onChange(next)
            setValue(next)
          }}
        />
      )
    }
    render(<Harness />)
    return { onChange }
  }

  it('has no time field and writes YYYY-MM-DD', async () => {
    const { onChange } = renderDatePicker()

    expect(screen.queryByLabelText(/time/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'From: Jan 14, 2026' }))
    const grid = await screen.findByRole('grid', { name: 'January 2026' })
    fireEvent.click(within(grid).getByRole('button', { name: 'Tuesday, January 20, 2026' }))

    expect(onChange).toHaveBeenLastCalledWith('2026-01-20')
    await waitFor(() => expect(screen.queryByRole('grid')).toBeNull())
    expect(screen.getByRole('button', { name: 'From: Jan 20, 2026' })).toBeInTheDocument()
  })

  it('disables days outside min and max, and keeps the keyboard inside them', async () => {
    const { onChange } = renderDatePicker('2026-01-14', { min: '2026-01-10', max: '2026-01-15' })

    fireEvent.click(screen.getByRole('button', { name: 'From: Jan 14, 2026' }))
    const grid = await screen.findByRole('grid', { name: 'January 2026' })
    expect(within(grid).getByRole('button', { name: 'Friday, January 9, 2026' })).toBeDisabled()
    expect(within(grid).getByRole('button', { name: 'Friday, January 16, 2026' })).toBeDisabled()
    expect(within(grid).getByRole('button', { name: 'Saturday, January 10, 2026' })).toBeEnabled()

    // A week forward would pass max: focus stops on the last allowed day.
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(within(grid).getByRole('button', { name: 'Thursday, January 15, 2026' })).toHaveFocus(),
    )
    expect(onChange).not.toHaveBeenCalled()
  })
})
