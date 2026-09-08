import type { EventPhotoComment } from '../types'

const BASE = '/api/v1'

async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const detail = typeof body.detail === 'string' ? body.detail : undefined
    throw new Error(detail || `${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/**
 * The discussion on an event itself, as opposed to on one of its attachments.
 *
 * No `branch` argument, deliberately: an event has ONE discussion, and the
 * server resolves a branch copy to its twin on main before reading or writing.
 * Passing a branch here would invite two threads on one conversation.
 */
export const eventCommentsApi = {
  list: async (slug: string, eventId: string): Promise<EventPhotoComment[]> => {
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/comments`, {
      credentials: 'include',
    })
    return unwrap<EventPhotoComment[]>(res)
  },

  create: async (
    slug: string,
    eventId: string,
    body: string,
    parentId: string | null = null,
  ): Promise<EventPhotoComment> => {
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/comments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, parent_id: parentId }),
    })
    return unwrap<EventPhotoComment>(res)
  },

  remove: async (slug: string, eventId: string, commentId: string): Promise<void> => {
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/comments/${commentId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    await unwrap<void>(res)
  },
}
