import { describe, expect, it, vi } from 'vitest'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import {
  PROJECT_EVENT_TYPES,
  invalidateForEvent,
  invalidationKeysFor,
  isProjectEventType,
} from './invalidationMap'

const SLUG = 'demo'

function hasKey(keys: QueryKey[], target: QueryKey): boolean {
  return keys.some((key) => JSON.stringify(key) === JSON.stringify(target))
}

describe('isProjectEventType', () => {
  it('accepts known event types and rejects others', () => {
    expect(isProjectEventType('scan_job.updated')).toBe(true)
    expect(isProjectEventType('metric_collection.updated')).toBe(true)
    expect(isProjectEventType('hello')).toBe(false)
    expect(isProjectEventType('nonsense')).toBe(false)
  })
})

describe('invalidationKeysFor', () => {
  it('returns a non-empty, slug-scoped key set for every event type', () => {
    for (const type of PROJECT_EVENT_TYPES) {
      const keys = invalidationKeysFor(type, SLUG)
      expect(keys.length).toBeGreaterThan(0)
    }
  })

  it('scan_job.updated refreshes scan + activity + events surfaces', () => {
    const keys = invalidationKeysFor('scan_job.updated', SLUG)
    expect(hasKey(keys, ['scans', SLUG])).toBe(true)
    expect(hasKey(keys, ['scanJobs', SLUG])).toBe(true)
    expect(hasKey(keys, ['activity', SLUG])).toBe(true)
    expect(hasKey(keys, ['activity', 'workspace'])).toBe(true)
    expect(hasKey(keys, ['overview'])).toBe(true)
  })

  it('metric_collection.updated refreshes metrics, monitors, reconciliation and overview', () => {
    const keys = invalidationKeysFor('metric_collection.updated', SLUG)
    expect(hasKey(keys, ['metrics-catalog', SLUG])).toBe(true)
    expect(hasKey(keys, ['monitoringMetrics', SLUG])).toBe(true)
    expect(hasKey(keys, ['eventsMetrics', SLUG])).toBe(true)
    expect(hasKey(keys, ['eventWindowMetrics', SLUG])).toBe(true)
    expect(hasKey(keys, ['reconciliation'])).toBe(true)
    expect(hasKey(keys, ['overview'])).toBe(true)
  })

  it('signals.updated refreshes anomalies, monitors and notifications', () => {
    const keys = invalidationKeysFor('signals.updated', SLUG)
    expect(hasKey(keys, ['anomalies', 'signals', SLUG])).toBe(true)
    expect(hasKey(keys, ['activeSignals', SLUG])).toBe(true)
    expect(hasKey(keys, ['monitors-summary', SLUG])).toBe(true)
    expect(hasKey(keys, ['topbarNotifications', SLUG])).toBe(true)
  })

  it('activity.created refreshes the activity rail and notification surfaces', () => {
    const keys = invalidationKeysFor('activity.created', SLUG)
    expect(hasKey(keys, ['activity', SLUG])).toBe(true)
    expect(hasKey(keys, ['topbarNotifications', SLUG])).toBe(true)
    expect(hasKey(keys, ['alertDeliveries', SLUG])).toBe(true)
  })

  it('project_summary.updated refreshes the project list and overview', () => {
    const keys = invalidationKeysFor('project_summary.updated', SLUG)
    expect(hasKey(keys, ['projects'])).toBe(true)
    expect(hasKey(keys, ['project', SLUG])).toBe(true)
  })
})

describe('invalidateForEvent', () => {
  it('invalidates every mapped key exactly once', () => {
    const invalidateQueries = vi.fn()
    const queryClient = { invalidateQueries } as unknown as QueryClient

    invalidateForEvent(queryClient, 'scan_job.updated', SLUG)

    const expected = invalidationKeysFor('scan_job.updated', SLUG)
    expect(invalidateQueries).toHaveBeenCalledTimes(expected.length)
    for (const key of expected) {
      expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: key })
    }
  })
})
