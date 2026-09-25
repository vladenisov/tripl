import { describe, expect, it } from 'vitest'
import { invalidValuesFor, valueRuleFor } from './variableValueValidation'

describe('variableValueValidation (PLAN-24)', () => {
  it('checks each typed value against its type', () => {
    expect(invalidValuesFor('number', ['1', '2.5', 'abc', ''])).toEqual(['abc', ''])
    expect(invalidValuesFor('boolean', ['true', 'false', 'yes'])).toEqual(['yes'])
    expect(invalidValuesFor('date', ['2026-09-25', '2026-02-30', 'tomorrow'])).toEqual(['2026-02-30', 'tomorrow'])
    expect(invalidValuesFor('datetime', ['2026-09-25T14:30:00Z', '2026-09-25 14:30', 'noon'])).toEqual(['noon'])
    expect(invalidValuesFor('json', ['{"a": 1}', '"text"', '{a}'])).toEqual(['{a}'])
    expect(invalidValuesFor('number_array', ['3', 'x'])).toEqual(['x'])
  })

  it('lets any value through for string types', () => {
    expect(invalidValuesFor('string', ['anything'])).toEqual([])
    expect(invalidValuesFor('string_array', ['anything'])).toEqual([])
    expect(valueRuleFor('string')).toEqual({})
    expect(valueRuleFor('number').validate?.('7')).toBe(true)
  })
})
