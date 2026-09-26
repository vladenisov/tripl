import { ApiError } from '@/api/client'

/** True when a request failed because the thing it asked for does not exist. */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}
