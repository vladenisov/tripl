import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { EventListItem } from '@/types'
import { readCreatedEvents, rememberCreatedEvents } from './createdEventsHandoff'
import {
  CREATED_FIND_WINDOW_MS,
  CREATED_HIGHLIGHT_MS,
  useCreatedEventsHighlight,
} from './useCreatedEventsHighlight'

const rows = (...ids: string[]) => ids.map(id => ({ id }) as EventListItem)

/** A scroller holding one marked row, as the table renders it. */
function scroller(marked = document.createElement('div')): { current: HTMLDivElement } {
  const div = document.createElement('div')
  marked.setAttribute('data-created', 'true')
  div.appendChild(marked)
  return { current: div }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useCreatedEventsHighlight', () => {
  it('marks the rows the form handed over, and takes the handoff once', () => {
    rememberCreatedEvents('demo', ['ev-2'])
    const { result } = renderHook(() =>
      useCreatedEventsHighlight({
        slug: 'demo',
        events: rows('ev-1', 'ev-2'),
        virtualize: false,
        scrollToIndex: vi.fn(),
        scrollRef: scroller(),
      }),
    )

    expect([...result.current]).toEqual(['ev-2'])
    expect(readCreatedEvents('demo')).toEqual([])
  })

  it('scrolls a short list to the first marked row in the DOM', () => {
    rememberCreatedEvents('demo', ['ev-2'])
    const marked = document.createElement('div')
    const scrollIntoView = vi.fn()
    marked.scrollIntoView = scrollIntoView
    const ref = scroller(marked)
    const scrollToIndex = vi.fn()
    renderHook(() =>
      useCreatedEventsHighlight({
        slug: 'demo',
        events: rows('ev-1', 'ev-2'),
        virtualize: false,
        scrollToIndex,
        scrollRef: ref,
      }),
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('asks the virtualizer for a row it may not have rendered, once', () => {
    rememberCreatedEvents('demo', ['ev-3'])
    const scrollToIndex = vi.fn()
    const { rerender } = renderHook(
      ({ events }) =>
        useCreatedEventsHighlight({
          slug: 'demo',
          events,
          virtualize: true,
          scrollToIndex,
          scrollRef: scroller(),
        }),
      // The cached page renders first; the refetch after the create brings the row.
      { initialProps: { events: rows('ev-1', 'ev-2') } },
    )
    expect(scrollToIndex).not.toHaveBeenCalled()

    rerender({ events: rows('ev-1', 'ev-2', 'ev-3') })
    rerender({ events: rows('ev-0', 'ev-1', 'ev-2', 'ev-3') })

    expect(scrollToIndex).toHaveBeenCalledTimes(1)
    expect(scrollToIndex).toHaveBeenCalledWith(2, { align: 'center' })
  })

  it('lets the mark fade once the row has been shown', () => {
    rememberCreatedEvents('demo', ['ev-1'])
    const { result } = renderHook(() =>
      useCreatedEventsHighlight({
        slug: 'demo',
        events: rows('ev-1'),
        virtualize: false,
        scrollToIndex: vi.fn(),
        scrollRef: scroller(),
      }),
    )

    act(() => vi.advanceTimersByTime(CREATED_HIGHLIGHT_MS - 1))
    expect(result.current.size).toBe(1)
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.size).toBe(0)
  })

  it('stops looking for a row that never turns up, without scrolling later', () => {
    rememberCreatedEvents('demo', ['ev-9'])
    const scrollToIndex = vi.fn()
    const { result, rerender } = renderHook(
      ({ events }) =>
        useCreatedEventsHighlight({
          slug: 'demo',
          events,
          virtualize: true,
          scrollToIndex,
          scrollRef: scroller(),
        }),
      { initialProps: { events: rows('ev-1') } },
    )

    act(() => vi.advanceTimersByTime(CREATED_FIND_WINDOW_MS))
    expect(result.current.size).toBe(0)
    // The reader has scrolled on by the time a later page brings it.
    rerender({ events: rows('ev-1', 'ev-9') })
    expect(scrollToIndex).not.toHaveBeenCalled()
  })

  it('marks nothing without a handoff', () => {
    const { result } = renderHook(() =>
      useCreatedEventsHighlight({
        slug: 'demo',
        events: rows('ev-1'),
        virtualize: false,
        scrollToIndex: vi.fn(),
        scrollRef: scroller(),
      }),
    )
    expect(result.current.size).toBe(0)
  })
})
