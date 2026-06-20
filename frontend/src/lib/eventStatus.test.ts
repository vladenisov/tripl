import { describe, expect, it } from 'vitest'
import {
  EVENT_STATUSES,
  EVENT_STATUS_BADGE_VARIANT,
  EVENT_STATUS_DOT_TONE,
  EVENT_STATUS_LABELS,
  EVENT_STATUS_TONE,
} from './eventStatus'

describe('event status lifecycle', () => {
  it('covers the full 7-state lifecycle in order', () => {
    expect(EVENT_STATUSES).toEqual([
      'draft',
      'in_review',
      'ready_for_dev',
      'implemented',
      'live',
      'deprecated',
      'archived',
    ])
  })

  it('has a label, tone, badge variant and dot tone for every status', () => {
    for (const status of EVENT_STATUSES) {
      expect(EVENT_STATUS_LABELS[status]).toBeTruthy()
      expect(EVENT_STATUS_TONE[status]).toBeTruthy()
      expect(EVENT_STATUS_BADGE_VARIANT[status]).toBeTruthy()
      expect(EVENT_STATUS_DOT_TONE[status]).toBeTruthy()
    }
  })

  it('matches the design mockup tone map (canonical STATUS_TONE)', () => {
    expect(EVENT_STATUS_TONE).toEqual({
      draft: 'neutral',
      in_review: 'warning',
      ready_for_dev: 'info',
      implemented: 'success',
      live: 'success',
      deprecated: 'warning',
      archived: 'neutral',
    })
  })

  it('keeps the status dot in lock-step with the canonical tone', () => {
    expect(EVENT_STATUS_DOT_TONE).toBe(EVENT_STATUS_TONE)
  })
})
