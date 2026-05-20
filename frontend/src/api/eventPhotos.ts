import type { EventPhoto } from '../types'

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

export const eventPhotosApi = {
  list: async (slug: string, eventId: string): Promise<EventPhoto[]> => {
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/photos`, {
      credentials: 'include',
    })
    return unwrap<EventPhoto[]>(res)
  },

  upload: async (slug: string, eventId: string, file: File): Promise<EventPhoto> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/photos`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    return unwrap<EventPhoto>(res)
  },

  delete: async (slug: string, eventId: string, photoId: string): Promise<void> => {
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/photos/${photoId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    await unwrap<void>(res)
  },

  reorder: async (
    slug: string,
    eventId: string,
    photoIds: string[],
  ): Promise<EventPhoto[]> => {
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/photos/reorder`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo_ids: photoIds }),
    })
    return unwrap<EventPhoto[]>(res)
  },
}
