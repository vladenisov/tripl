import { describe, expect, it } from 'vitest'
import { inlineRecord, isFlatRecord, uniformRecords } from './diffValueFormat'

describe('isFlatRecord', () => {
  it('accepts a record whose values are all scalar', () => {
    expect(isFlatRecord({ field_name: 'screen', value: 'spot' })).toBe(true)
    expect(isFlatRecord({ value: null })).toBe(true)
  })

  it('rejects arrays, null, and anything nested', () => {
    expect(isFlatRecord([{ a: 1 }])).toBe(false)
    expect(isFlatRecord(null)).toBe(false)
    expect(isFlatRecord({ comments: [{ body: 'hi' }] })).toBe(false)
    expect(isFlatRecord('spot')).toBe(false)
  })
})

describe('inlineRecord', () => {
  it('joins the pairs and marks the empty ones', () => {
    expect(inlineRecord({ field_name: 'screen', value: 'spot' })).toBe(
      'field_name: screen · value: spot',
    )
    // An empty value and a null one both read as "nothing here"; printing ''
    // would leave the key dangling with no answer after it.
    expect(inlineRecord({ value: '', other: null })).toBe('value: ∅ · other: ∅')
  })
})

describe('uniformRecords', () => {
  it('accepts an array of flat records that all carry the same keys', () => {
    const rows = [
      { field_name: 'screen', value: 'spot' },
      { field_name: 'action', value: 'tap' },
    ]
    expect(uniformRecords(rows)).toBe(rows)
  })

  it('refuses a ragged array — a table would invent columns', () => {
    expect(uniformRecords([{ field_name: 'screen' }, { field_name: 'action', value: 'tap' }])).toBe(
      null,
    )
  })

  it('refuses a nested member, which is what keeps photos out of the table', () => {
    // A photo member carries a `comments` list and an override member a
    // `values` list; both keep the prose form.
    expect(uniformRecords([{ filename: 'a.png', comments: [{ body: 'hi' }] }])).toBe(null)
  })

  it('has nothing to render for an empty array or a non-array', () => {
    expect(uniformRecords([])).toBe(null)
    expect(uniformRecords('spot')).toBe(null)
  })
})
