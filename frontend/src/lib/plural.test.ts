import { describe, expect, it } from 'vitest'
import { countOf, pluralize } from './plural'

describe('pluralize', () => {
  it('takes the singular only at exactly 1', () => {
    expect(pluralize(1, 'scan', 'scans')).toBe('scan')
    expect(pluralize(0, 'scan', 'scans')).toBe('scans')
    expect(pluralize(2, 'scan', 'scans')).toBe('scans')
  })

  // The reason this picks between two caller-written strings rather than
  // appending an "s": agreement can reach past the noun into the verb.
  it('carries agreement past the noun when the caller writes both forms', () => {
    expect(pluralize(1, '1 project currently has', '3 projects currently have')).toBe(
      '1 project currently has',
    )
    expect(pluralize(3, '1 project currently has', '3 projects currently have')).toBe(
      '3 projects currently have',
    )
  })
})

describe('countOf', () => {
  // The defect this module exists for: a project with one scan read "1 scans"
  // on the Scans list — the page the scan epic exists to make comprehensible.
  it('agrees with the number it prints', () => {
    expect(countOf(1, 'scan', 'scans')).toBe('1 scan')
    expect(countOf(0, 'scan', 'scans')).toBe('0 scans')
    expect(countOf(12, 'scan', 'scans')).toBe('12 scans')
  })

  it('groups thousands so a large count stays readable', () => {
    expect(countOf(4812, 'row', 'rows')).toBe('4,812 rows')
  })
})
