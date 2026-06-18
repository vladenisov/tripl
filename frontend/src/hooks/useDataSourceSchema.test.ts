import { describe, expect, it } from 'vitest'
import { toSQLNamespace } from './useDataSourceSchema'
import type { TableSchema } from '@/types/dataSourceSchema'

describe('toSQLNamespace', () => {
  it('maps each table to its column names', () => {
    const tables: TableSchema[] = [
      {
        name: 'events',
        columns: [
          { name: 'id', data_type: 'UInt64' },
          { name: 'created_at', data_type: 'DateTime' },
        ],
      },
      {
        name: 'users',
        columns: [{ name: 'email', data_type: 'String' }],
      },
    ]

    expect(toSQLNamespace(tables)).toEqual({
      events: ['id', 'created_at'],
      users: ['email'],
    })
  })

  it('returns an empty namespace for no tables', () => {
    expect(toSQLNamespace([])).toEqual({})
  })

  it('keeps tables with no columns as empty arrays', () => {
    const tables: TableSchema[] = [{ name: 'empty', columns: [] }]
    expect(toSQLNamespace(tables)).toEqual({ empty: [] })
  })
})
