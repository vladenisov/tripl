import { ApiError } from '@/api/client'

/**
 * Default query retry: once, and never for a 4xx.
 *
 * A 400/403/404/409/422 is the server's settled answer; asking again only adds
 * a second of retry delay before the error UI shows. A 401 retried also fired
 * the re-authentication event twice per query. 408 (the client's own timeout
 * mapping) and 429 are the 4xx worth a second try.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  ) {
    return false
  }
  return failureCount < 1
}
