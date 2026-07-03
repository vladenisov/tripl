import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TableSchema } from '@/types/dataSourceSchema'
import { SqlSchemaBrowser } from './sql-schema-browser'

const TABLES: TableSchema[] = [
  {
    name: 'orders',
    columns: [
      { name: 'id', data_type: 'bigint' },
      { name: 'amount', data_type: 'numeric' },
    ],
  },
  {
    name: 'sessions',
    columns: [{ name: 'user_id', data_type: 'uuid' }],
  },
]

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Tables/ }))
}

describe('SqlSchemaBrowser', () => {
  it('keeps the panel collapsed until toggled', () => {
    render(<SqlSchemaBrowser tables={TABLES} onInsert={vi.fn()} />)
    expect(screen.queryByLabelText('Filter tables and columns')).toBeNull()
    openPanel()
    expect(screen.getByLabelText('Filter tables and columns')).toBeInTheDocument()
  })

  it('inserts the table name when its row is clicked', () => {
    const onInsert = vi.fn()
    render(<SqlSchemaBrowser tables={TABLES} onInsert={onInsert} />)
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'orders' }))
    expect(onInsert).toHaveBeenCalledWith('orders')
  })

  it('reveals columns on expand and inserts a column name', () => {
    const onInsert = vi.fn()
    render(<SqlSchemaBrowser tables={TABLES} onInsert={onInsert} />)
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle columns for orders' }))
    const amount = screen.getByRole('button', { name: /amount/ })
    expect(amount).toHaveTextContent('numeric')
    fireEvent.click(amount)
    expect(onInsert).toHaveBeenCalledWith('amount')
  })

  it('filters tables and columns by query', () => {
    render(<SqlSchemaBrowser tables={TABLES} onInsert={vi.fn()} />)
    openPanel()
    fireEvent.change(screen.getByLabelText('Filter tables and columns'), {
      target: { value: 'amount' },
    })
    // The matching column is auto-revealed; the non-matching table disappears.
    expect(screen.getByRole('button', { name: /amount/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'sessions' })).toBeNull()
  })
})
