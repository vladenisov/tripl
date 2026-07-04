import { describe, expect, it } from 'vitest'
import { computeVirtualRowCount } from './useEventsTableVirtualization'

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
