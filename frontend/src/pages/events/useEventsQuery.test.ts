import { describe, expect, it } from 'vitest'
import { resolveQueryStatuses, tabDefaultStatuses } from './useEventsQuery'

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

describe('tabDefaultStatuses', () => {
  it('names what the review and archived tabs narrow to, and nothing elsewhere', () => {
    expect(tabDefaultStatuses('review')).toEqual(['in_review'])
    expect(tabDefaultStatuses('archived')).toEqual(['archived'])
    expect(tabDefaultStatuses('all')).toBeNull()
    expect(resolveQueryStatuses('archived', [])).toEqual(['archived'])
  })
})
