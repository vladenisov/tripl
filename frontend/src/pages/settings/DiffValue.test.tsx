import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DiffValue, RecordTable } from './DiffValue'

describe('DiffValue', () => {
  it('marks every shape of empty with the same symbol', () => {
    // A blank cell cannot be told from a cell that failed to render, which is
    // the whole reason the empty state has a glyph of its own.
    for (const empty of [null, undefined, '', []]) {
      const { unmount } = render(<DiffValue value={empty} />)
      expect(screen.getByText('∅')).toBeInTheDocument()
      unmount()
    }
  })

  it('joins a list of scalars instead of stacking them', () => {
    render(<DiffValue value={['spot', 'profile']} />)

    expect(screen.getByText('spot, profile')).toBeInTheDocument()
  })

  it('reads a flat record as prose', () => {
    render(<DiffValue value={{ field_name: 'screen', value: 'spot' }} />)

    expect(screen.getByText('field_name: screen · value: spot')).toBeInTheDocument()
  })

  it('gives one line to each member of a list of flat records', () => {
    render(
      <DiffValue
        value={[
          { field_name: 'screen', value: 'spot' },
          { field_name: 'action', value: 'tap' },
        ]}
      />,
    )

    expect(screen.getByText('field_name: screen · value: spot')).toBeInTheDocument()
    expect(screen.getByText('field_name: action · value: tap')).toBeInTheDocument()
  })

  it('falls back to formatted JSON for anything nested', () => {
    render(<DiffValue value={{ filename: 'a.png', comments: [{ body: 'hi' }] }} />)

    expect(screen.getByText(/"filename": "a.png"/)).toBeInTheDocument()
  })

  it('renders a table only when asked, and only for a uniform list', () => {
    const rows = [
      { field_name: 'screen', value: 'spot' },
      { field_name: 'action', value: 'tap' },
    ]
    const { unmount } = render(<DiffValue value={rows} table />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    unmount()

    // Same value, no `table`: the prose form, because only the full-state view
    // has the width for a table.
    render(<DiffValue value={rows} />)
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('keeps the prose form for a ragged list even when a table is asked for', () => {
    render(
      <DiffValue value={[{ field_name: 'screen' }, { field_name: 'action', value: 'tap' }]} table />,
    )

    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('RecordTable', () => {
  it('labels the columns and drops the repeated key column header', () => {
    render(
      <RecordTable
        rows={[
          { field_name: 'screen', value: 'spot' },
          { field_name: 'action', value: 'tap' },
        ]}
      />,
    )

    expect(screen.getByRole('columnheader', { name: 'Field' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Value' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'spot' })).toBeInTheDocument()
  })

  it('hides a long JSON cell behind a disclosure rather than blowing out the row', () => {
    const payload = JSON.stringify({ from_profile: '${property.forecast_profile}', mode: 'dark' })
    render(<RecordTable rows={[{ field_name: 'payload', value: payload }]} />)

    const toggle = screen.getByRole('button')
    expect(screen.queryByText(/"mode": "dark"/)).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText(/"mode": "dark"/)).toBeInTheDocument()
  })
})
