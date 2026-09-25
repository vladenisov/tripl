import { describe, expect, it } from 'vitest'
import { computeVirtualRowCount, shouldFetchNextPage } from './useEventsTableVirtualization'

describe('computeVirtualRowCount', () => {
  it('sizes the spacer to the server total, not the loaded page', () => {
    // The bug: sizing to loadedCount grew the spacer one page at a time, so the
    // scrollbar could not map linearly to the whole list.
    expect(
      computeVirtualRowCount({
        virtualize: true,
        isClientFiltered: false,
        loadedCount: 200,
        total: 724,
      }),
    ).toBe(724)
  })

  it('never shrinks below the loaded count when total lags', () => {
    expect(
      computeVirtualRowCount({
        virtualize: true,
        isClientFiltered: false,
        loadedCount: 300,
        total: 250,
      }),
    ).toBe(300)
  })

  it('uses the filtered length under a client-side field/meta filter', () => {
    expect(
      computeVirtualRowCount({
        virtualize: true,
        isClientFiltered: true,
        loadedCount: 40,
        total: 724,
      }),
    ).toBe(40)
  })

  it('returns 0 when the list is below the virtualization threshold', () => {
    expect(
      computeVirtualRowCount({
        virtualize: false,
        isClientFiltered: false,
        loadedCount: 20,
        total: 20,
      }),
    ).toBe(0)
  })
})

describe('shouldFetchNextPage', () => {
  const base = {
    hasNextPage: true,
    isFetchingNextPage: false,
    virtualize: false,
    isClientFiltered: false,
    loadedCount: 40,
    lastVisibleIndex: undefined,
  }

  it('keeps paging under a column filter whose first page matched nothing (EVT-4)', () => {
    // Stopping at an empty page showed "No events match" over a catalog whose
    // later pages held matches.
    expect(shouldFetchNextPage({ ...base, isClientFiltered: true, loadedCount: 0 })).toBe(true)
  })

  it('does not page an empty unfiltered list, or while a page is in flight', () => {
    expect(shouldFetchNextPage({ ...base, loadedCount: 0 })).toBe(false)
    expect(shouldFetchNextPage({ ...base, isFetchingNextPage: true })).toBe(false)
    expect(shouldFetchNextPage({ ...base, hasNextPage: false })).toBe(false)
  })

  it('pages a virtualized list only as the viewport nears the loaded end', () => {
    const virtual = { ...base, virtualize: true, loadedCount: 400 }
    expect(shouldFetchNextPage({ ...virtual, lastVisibleIndex: 100 })).toBe(false)
    expect(shouldFetchNextPage({ ...virtual, lastVisibleIndex: 360 })).toBe(true)
  })
})
