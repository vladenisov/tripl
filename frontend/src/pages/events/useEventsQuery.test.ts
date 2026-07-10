import { describe, expect, it } from 'vitest'
import { resolveQueryStatuses } from './useEventsQuery'

describe('resolveQueryStatuses', () => {
  it('Any status (no explicit filter) includes draft and excludes only archived', () => {
    const statuses = resolveQueryStatuses('all', [])
    expect(statuses).toContain('draft')
    expect(statuses).toContain('in_review')
    expect(statuses).toContain('live')
    expect(statuses).not.toContain('archived')
  })

  it('review/archived tabs act as defaults only', () => {
    expect(resolveQueryStatuses('review', [])).toEqual(['in_review'])
    expect(resolveQueryStatuses('archived', [])).toEqual(['archived'])
  })

  it('an explicit dropdown filter beats the tab default', () => {
    expect(resolveQueryStatuses('review', ['draft'])).toEqual(['draft'])
    expect(resolveQueryStatuses('archived', ['draft', 'live'])).toEqual(['draft', 'live'])
  })
})
