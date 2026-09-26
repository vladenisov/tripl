import { describe, expect, it } from 'vitest'
import { withThrowingStorage } from '@/test/storage'
import { forgetCreatedEvents, readCreatedEvents, rememberCreatedEvents } from './createdEventsHandoff'

describe('createdEventsHandoff', () => {
  it('hands the created ids to the list of the same project only', () => {
    rememberCreatedEvents('demo', ['ev-1', 'ev-2'], 1_000)

    expect(readCreatedEvents('demo', 2_000)).toEqual(['ev-1', 'ev-2'])
    expect(readCreatedEvents('other', 2_000)).toEqual([])
  })

  it('adds to a handoff the list has not taken, so a run marks every event', () => {
    rememberCreatedEvents('demo', ['ev-1'], 1_000)
    rememberCreatedEvents('demo', ['ev-2', 'ev-1'], 2_000)

    expect(readCreatedEvents('demo', 3_000)).toEqual(['ev-1', 'ev-2'])
  })

  it('is taken once: forgotten after the list reads it', () => {
    rememberCreatedEvents('demo', ['ev-1'], 1_000)
    forgetCreatedEvents('demo')

    expect(readCreatedEvents('demo', 1_000)).toEqual([])
  })

  it('goes stale after a minute, so a later visit does not mark old rows', () => {
    rememberCreatedEvents('demo', ['ev-1'], 1_000)

    expect(readCreatedEvents('demo', 1_000 + 61_000)).toEqual([])
  })

  it('ignores a malformed entry', () => {
    sessionStorage.setItem('tripl:created-events:demo', '{"ids":"ev-1"}')
    expect(readCreatedEvents('demo')).toEqual([])
    sessionStorage.setItem('tripl:created-events:demo', 'not json')
    expect(readCreatedEvents('demo')).toEqual([])
  })

  it('does nothing, and throws nothing, where storage is unavailable', () => {
    withThrowingStorage()

    expect(() => rememberCreatedEvents('demo', ['ev-1'])).not.toThrow()
    expect(readCreatedEvents('demo')).toEqual([])
    expect(() => forgetCreatedEvents('demo')).not.toThrow()
  })
})
