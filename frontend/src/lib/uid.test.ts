import { afterEach, describe, expect, it, vi } from 'vitest'
import { uid } from './uid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses crypto.randomUUID when the context is secure', () => {
    expect(uid()).toMatch(UUID_V4)
  })

  it('still returns a v4 UUID when crypto.randomUUID is missing (plain HTTP)', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
    const a = uid()
    const b = uid()
    expect(a).toMatch(UUID_V4)
    expect(b).toMatch(UUID_V4)
    expect(a).not.toBe(b)
  })
})
