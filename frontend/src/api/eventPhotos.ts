import type { EventPhoto, EventPhotoComment } from '../types'

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

  attachFigma: async (
    slug: string,
    eventId: string,
    url: string,
    title = '',
  ): Promise<EventPhoto> => {
    const res = await fetch(`${BASE}/projects/${slug}/events/${eventId}/photos/figma`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title }),
    })
    return unwrap<EventPhoto>(res)
  },

  listComments: async (
    slug: string,
    eventId: string,
    photoId: string,
  ): Promise<EventPhotoComment[]> => {
    const res = await fetch(
      `${BASE}/projects/${slug}/events/${eventId}/photos/${photoId}/comments`,
      { credentials: 'include' },
    )
    return unwrap<EventPhotoComment[]>(res)
  },

  createComment: async (
    slug: string,
    eventId: string,
    photoId: string,
    body: string,
    parentId: string | null = null,
  ): Promise<EventPhotoComment> => {
    const res = await fetch(
      `${BASE}/projects/${slug}/events/${eventId}/photos/${photoId}/comments`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, parent_id: parentId }),
      },
    )
    return unwrap<EventPhotoComment>(res)
  },

  deleteComment: async (
    slug: string,
    eventId: string,
    photoId: string,
    commentId: string,
  ): Promise<void> => {
    const res = await fetch(
      `${BASE}/projects/${slug}/events/${eventId}/photos/${photoId}/comments/${commentId}`,
      { method: 'DELETE', credentials: 'include' },
    )
    await unwrap<void>(res)
  },
}
