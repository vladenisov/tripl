const BASE = '/api/v1'
const BACKEND_UNAVAILABLE_MESSAGE = 'Backend is unavailable. Check that the API server is running and try again.'
export const AUTH_UNAUTHORIZED_EVENT = 'tripl:unauthorized'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function emitUnauthorized(path: string, status: number) {
  if (status !== 401 || path.startsWith('/auth') || typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT))
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  const headers = new Headers(init?.headers)

  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(
        'Request to the backend timed out. Try again after the API becomes available.',
        408,
      )
    }
    throw new ApiError(BACKEND_UNAVAILABLE_MESSAGE, 503)
  }

  if (!res.ok) {
    if ([502, 503, 504].includes(res.status)) {
      throw new ApiError(BACKEND_UNAVAILABLE_MESSAGE, res.status)
    }

    emitUnauthorized(path, res.status)
    const body = await res.json().catch(() => ({}))
    const detail = typeof body.detail === 'string' ? body.detail : undefined
    throw new ApiError(detail || `${res.status} ${res.statusText}`, res.status)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, {
      method: 'POST',
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/** Append `?branch=<id>` (or `&branch=<id>`) to a path. No-op when branchId is null/undefined. */
export function withBranch(path: string, branchId?: string | null): string {
  if (!branchId) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}branch=${encodeURIComponent(branchId)}`
}
