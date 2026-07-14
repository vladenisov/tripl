import { describe, expect, test } from 'vitest'

import { factColumnValueKind } from './factColumnValueKind'

describe('factColumnValueKind', () => {
  // These four are the ONLY values the API can return for FactTableColumn.type:
  // fact-table introspection buckets every warehouse type into them server-side.
  // Keeping the test keyed to the buckets — rather than to warehouse type names
  // like 'Int64' — is the point: a fixture the API can never produce would let a
  // regression through with green CI.
  test('maps the numeric bucket to number', () => {
    expect(factColumnValueKind('number')).toBe('number')
  })

  test('maps the boolean bucket to boolean', () => {
    expect(factColumnValueKind('bool')).toBe('boolean')
  })

  test.each(['string', 'timestamp'])('serializes the %s bucket as string', columnType => {
    expect(factColumnValueKind(columnType)).toBe('string')
  })

  test.each([null, undefined, ''])('falls back to string for %s', columnType => {
    expect(factColumnValueKind(columnType)).toBe('string')
  })
})
