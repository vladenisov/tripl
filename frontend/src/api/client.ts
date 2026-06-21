const BASE = '/api/v1'
const BACKEND_UNAVAILABLE_MESSAGE = 'Backend is unavailable. Check that the API server is running and try again.'
export const AUTH_UNAUTHORIZED_EVENT = 'tripl:unauthorized'

/** One entry of a FastAPI 422 validation error `detail` array. */
export interface ApiFieldError {
  loc: (string | number)[]
  msg: string
  type: string
}

export class ApiError extends Error {
  status: number
  /** Structured field errors from a FastAPI 422 response, when present. */
  fields?: ApiFieldError[]
  /** Backend request id (`X-Request-ID` / 500 body) for support references. */
  requestId?: string

  constructor(message: string, status: number, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.requestId = requestId
  }
}

function emitUnauthorized(path: string, status: number) {
  // 401 means re-authenticate; 403 is an authorization failure on a valid
  // session and must NOT trigger the re-auth flow.
  if (status !== 401 || path.startsWith('/auth') || typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT))
}

/** Build a readable message from a FastAPI 422 `detail` array. */
function formatValidationDetail(detail: ApiFieldError[]): string {
  return detail
    .map((item) => {
      // Drop the leading "body"/"query" segment for a tidier path.
      const path = item.loc.filter((seg) => seg !== 'body' && seg !== 'query').join('.')
      return path ? `${path}: ${item.msg}` : item.msg
    })
    .join('; ')
}

function isFieldErrorArray(detail: unknown): detail is ApiFieldError[] {
  return (
    Array.isArray(detail) &&
    detail.every(
      (item) =>
        item != null &&
        typeof item === 'object' &&
        'msg' in item &&
        'loc' in item &&
        Array.isArray((item as { loc: unknown }).loc),
    )
  )
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  const headers = new Headers(init?.headers)

  if (init?.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  // Correlate this request with backend logs/traces. The backend echoes the id
  // back on the response and 500 bodies (see RequestIDMiddleware).
  if (!headers.has('X-Request-ID')) {
    headers.set('X-Request-ID', crypto.randomUUID())
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
    const body = await res.json().catch(() => ({}))
    // Prefer the backend echo header; fall back to a request_id in a 500 body.
    const requestId =
      res.headers.get('X-Request-ID') ??
      (typeof body.request_id === 'string' ? body.request_id : undefined) ??
      undefined

    if ([502, 503, 504].includes(res.status)) {
      // Use a meaningful body.detail when the gateway/app supplied one.
      const detail = typeof body.detail === 'string' ? body.detail : undefined
      throw new ApiError(detail || BACKEND_UNAVAILABLE_MESSAGE, res.status, requestId)
    }

    emitUnauthorized(path, res.status)

    if (isFieldErrorArray(body.detail)) {
      const error = new ApiError(formatValidationDetail(body.detail), res.status, requestId)
      error.fields = body.detail
      throw error
    }

    const detail = typeof body.detail === 'string' ? body.detail : undefined
    throw new ApiError(detail || `${res.status} ${res.statusText}`, res.status, requestId)
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
  put: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(data) }),
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
