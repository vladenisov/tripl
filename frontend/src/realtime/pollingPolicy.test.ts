import { describe, expect, it } from 'vitest'
import { resolveRefetchInterval, type StreamStatus } from './pollingPolicy'

const base = { activeMs: 5000 as const }

describe('resolveRefetchInterval', () => {
  it('never polls a hidden tab, regardless of stream status', () => {
    for (const streamStatus of ['connecting', 'live', 'degraded', 'closed'] as StreamStatus[]) {
      expect(
        resolveRefetchInterval({ ...base, streamStatus, documentHidden: true }),
      ).toBe(false)
    }
  })

  it('does not poll while the stream is live (updates arrive via SSE)', () => {
    expect(
      resolveRefetchInterval({ ...base, streamStatus: 'live', documentHidden: false }),
    ).toBe(false)
  })

  it('polls at the active cadence when the stream is down or degraded', () => {
    expect(
      resolveRefetchInterval({ ...base, streamStatus: 'closed', documentHidden: false }),
    ).toBe(5000)
    expect(
      resolveRefetchInterval({ ...base, streamStatus: 'degraded', documentHidden: false }),
    ).toBe(5000)
    expect(
      resolveRefetchInterval({ ...base, streamStatus: 'connecting', documentHidden: false }),
    ).toBe(5000)
  })

  it('stops fast polling once the watched work reaches a terminal state', () => {
    expect(
      resolveRefetchInterval({
        ...base,
        streamStatus: 'closed',
        documentHidden: false,
        active: false,
      }),
    ).toBe(false)
  })

  it('honours an explicit idle cadence when work is terminal', () => {
    expect(
      resolveRefetchInterval({
        ...base,
        streamStatus: 'closed',
        documentHidden: false,
        active: false,
        idleMs: 30_000,
      }),
    ).toBe(30_000)
  })

  it('polls when active work remains and the stream is down', () => {
    expect(
      resolveRefetchInterval({
        ...base,
        streamStatus: 'closed',
        documentHidden: false,
        active: true,
      }),
    ).toBe(5000)
  })
})
