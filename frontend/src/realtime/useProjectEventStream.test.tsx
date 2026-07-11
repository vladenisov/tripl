import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectEventStream } from './useProjectEventStream'

// Minimal EventSource stand-in: records instances + listeners so tests can drive
// events and inspect reconnect behaviour (jsdom ships no EventSource).
class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  withCredentials: boolean
  onerror: ((e: Event) => void) | null = null
  closed = false
  private listeners: Record<string, Array<(e: MessageEvent) => void>> = {}

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = init?.withCredentials ?? false
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }

  removeEventListener(): void {}

  close(): void {
    this.closed = true
  }

  emit(type: string, data: string, lastEventId = ''): void {
    const event = { type, data, lastEventId } as MessageEvent
    for (const cb of this.listeners[type] ?? []) cb(event)
  }

  fail(): void {
    this.onerror?.(new Event('error'))
  }
}

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { wrapper, invalidateSpy }
}

function invalidateCallsFor(spy: ReturnType<typeof vi.fn>, key: unknown): number {
  return spy.mock.calls.filter(
    (call) => JSON.stringify((call[0] as { queryKey: unknown }).queryKey) === JSON.stringify(key),
  ).length
}

beforeEach(() => {
  MockEventSource.instances = []
  ;(globalThis as unknown as { EventSource: unknown }).EventSource =
    MockEventSource as unknown
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useProjectEventStream', () => {
  it('opens a credentialed stream to the project endpoint', () => {
    const { wrapper } = makeWrapper()
    renderHook(() => useProjectEventStream('demo'), { wrapper })

    expect(MockEventSource.instances).toHaveLength(1)
    const source = MockEventSource.instances[0]
    expect(source.url).toContain('/api/v1/projects/demo/events/stream')
    expect(source.withCredentials).toBe(true)
  })

  it('does not open a stream without a slug', () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useProjectEventStream(undefined), { wrapper })
    expect(MockEventSource.instances).toHaveLength(0)
    expect(result.current).toBe('closed')
  })

  it('reports "live" on hello(redis) and "degraded" on hello(non-redis)', () => {
    const { wrapper } = makeWrapper()
    const { result } = renderHook(() => useProjectEventStream('demo'), { wrapper })
    const source = MockEventSource.instances[0]

    act(() => source.emit('hello', JSON.stringify({ backend: 'redis' }), '0'))
    expect(result.current).toBe('live')

    act(() => source.emit('hello', JSON.stringify({ backend: 'degraded' }), '0'))
    expect(result.current).toBe('degraded')
  })

  it('invalidates mapped keys on a project event', () => {
    const { wrapper, invalidateSpy } = makeWrapper()
    renderHook(() => useProjectEventStream('demo'), { wrapper })
    const source = MockEventSource.instances[0]

    act(() =>
      source.emit('scan_job.updated', JSON.stringify({ project_slug: 'demo' }), '1'),
    )

    expect(invalidateCallsFor(invalidateSpy, ['scans', 'demo'])).toBe(1)
    expect(invalidateCallsFor(invalidateSpy, ['activity', 'demo'])).toBe(1)
  })

  it('de-duplicates a replayed event by id (no duplicate invalidation)', () => {
    const { wrapper, invalidateSpy } = makeWrapper()
    renderHook(() => useProjectEventStream('demo'), { wrapper })
    const source = MockEventSource.instances[0]

    act(() => source.emit('signals.updated', '{}', '5'))
    act(() => source.emit('signals.updated', '{}', '5')) // replayed, same id

    expect(invalidateCallsFor(invalidateSpy, ['anomalies', 'signals', 'demo'])).toBe(1)
  })

  it('reconnects with backoff carrying the Last-Event-ID cursor', () => {
    vi.useFakeTimers()
    const { wrapper } = makeWrapper()
    renderHook(() => useProjectEventStream('demo'), { wrapper })
    const first = MockEventSource.instances[0]

    // Advance the cursor, then drop the connection.
    act(() => first.emit('scan_job.updated', '{}', '9'))
    act(() => first.fail())
    expect(first.closed).toBe(true)
    expect(MockEventSource.instances).toHaveLength(1)

    // Backoff elapses → a new stream opens, resuming from the last id.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(MockEventSource.instances).toHaveLength(2)
    expect(MockEventSource.instances[1].url).toContain('last_event_id=9')
  })

  it('closes the stream on unmount', () => {
    const { wrapper } = makeWrapper()
    const { unmount } = renderHook(() => useProjectEventStream('demo'), { wrapper })
    const source = MockEventSource.instances[0]
    unmount()
    expect(source.closed).toBe(true)
  })
})
