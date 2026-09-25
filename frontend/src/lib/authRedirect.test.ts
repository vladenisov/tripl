import { describe, expect, it } from 'vitest'
import { postLoginDestination } from './authRedirect'

describe('postLoginDestination', () => {
  it('keeps the query string and fragment of the page the visitor was sent from', () => {
    const state = {
      from: {
        pathname: '/p/demo/settings/alerting/d-1',
        search: '?item=i-1&incident=inc-2',
        hash: '#card',
      },
    }
    expect(postLoginDestination(state)).toBe('/p/demo/settings/alerting/d-1?item=i-1&incident=inc-2#card')
  })

  it('falls back to the root without a recorded origin', () => {
    expect(postLoginDestination(null)).toBe('/')
    expect(postLoginDestination({})).toBe('/')
    expect(postLoginDestination({ from: {} })).toBe('/')
  })
})
