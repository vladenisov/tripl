import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { shouldRetryQuery } from './queryRetry'

describe('shouldRetryQuery', () => {
  it.each([400, 401, 403, 404, 409, 422])('does not retry a %i', (status) => {
    expect(shouldRetryQuery(0, new ApiError('no', status))).toBe(false)
  })

  it.each([408, 429, 500, 503])('retries a %i once', (status) => {
    expect(shouldRetryQuery(0, new ApiError('later', status))).toBe(true)
    expect(shouldRetryQuery(1, new ApiError('later', status))).toBe(false)
  })

  it('retries a non-API error once', () => {
    expect(shouldRetryQuery(0, new Error('parse'))).toBe(true)
    expect(shouldRetryQuery(1, new Error('parse'))).toBe(false)
  })
})
