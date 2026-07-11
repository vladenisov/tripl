/**
 * Project event stream subscription hook (tripl-2su6.8).
 *
 * Opens an `EventSource` to `GET /api/v1/projects/{slug}/events/stream` and, on
 * each named event, invalidates the mapped React-Query keys (see
 * {@link ./invalidationMap}). One-way: server → client only.
 *
 * Reconnect: manual with exponential backoff, carrying the `Last-Event-ID`
 * cursor as `?last_event_id=` so the server can replay missed events. Duplicate
 * delivery (replay, StrictMode remount) is harmless — invalidation is
 * idempotent — and additionally de-duplicated by monotonic event id.
 *
 * Status: `connecting` until the server's `hello` event, then `live` (Redis pub/
 * sub delivering) or `degraded` (Redis off — clients keep polling); `closed`
 * while disconnected/reconnecting. The returned status drives the adaptive
 * polling fallback. Status transitions happen only from async callbacks (SSE
 * events, reconnect timers) or a render-time reset on slug change — never
 * synchronously inside the effect body.
 */

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { StreamStatus } from './pollingPolicy'
import { PROJECT_EVENT_TYPES, invalidateForEvent, isProjectEventType } from './invalidationMap'

const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
const HELLO_EVENT = 'hello'

interface HelloPayload {
  backend?: string
}

function initialStatus(slug: string | undefined): StreamStatus {
  return slug ? 'connecting' : 'closed'
}

function streamUrl(slug: string, lastEventId: string | null): string {
  const base = `/api/v1/projects/${encodeURIComponent(slug)}/events/stream`
  return lastEventId ? `${base}?last_event_id=${encodeURIComponent(lastEventId)}` : base
}

/**
 * Subscribe to a project's live update stream. Returns the current stream status
 * (also used by the adaptive polling policy). No-op when `slug` is undefined.
 */
export function useProjectEventStream(slug: string | undefined): StreamStatus {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<StreamStatus>(() => initialStatus(slug))

  // Reset status the moment the project scope changes (render-time derived state,
  // the React-documented alternative to a setState-in-effect). The connection
  // effect below then re-subscribes for the new slug.
  const [lastSlug, setLastSlug] = useState(slug)
  if (lastSlug !== slug) {
    setLastSlug(slug)
    setStatus(initialStatus(slug))
  }

  // Mutable connection state kept in refs so reconnect scheduling never triggers
  // re-subscribes; the effect re-runs only when the project slug changes.
  const sourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptsRef = useRef(0)
  const lastEventIdRef = useRef<string | null>(null)
  const lastProcessedIdRef = useRef(0)

  useEffect(() => {
    if (!slug) return

    let disposed = false

    const clearReconnect = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (disposed) return
      const delay = Math.min(BASE_BACKOFF_MS * 2 ** attemptsRef.current, MAX_BACKOFF_MS)
      attemptsRef.current += 1
      clearReconnect()
      reconnectTimerRef.current = setTimeout(connect, delay)
    }

    const handleProjectEvent = (event: MessageEvent) => {
      if (disposed) return
      if (event.lastEventId) lastEventIdRef.current = event.lastEventId
      // De-dupe by monotonic id so a reconnect replay never double-invalidates.
      const id = Number(event.lastEventId)
      if (Number.isFinite(id) && id > 0) {
        if (id <= lastProcessedIdRef.current) return
        lastProcessedIdRef.current = id
      }
      if (isProjectEventType(event.type)) {
        invalidateForEvent(queryClient, event.type, slug)
      }
    }

    const handleHello = (event: MessageEvent) => {
      if (disposed) return
      attemptsRef.current = 0
      let backend: string | undefined
      try {
        backend = (JSON.parse(event.data) as HelloPayload).backend
      } catch {
        backend = undefined
      }
      setStatus(backend === 'redis' ? 'live' : 'degraded')
    }

    function connect() {
      if (disposed) return
      const EventSourceCtor = globalThis.EventSource
      if (!EventSourceCtor) return
      const source = new EventSourceCtor(streamUrl(slug!, lastEventIdRef.current), {
        withCredentials: true,
      })
      sourceRef.current = source

      source.addEventListener(HELLO_EVENT, handleHello as EventListener)
      for (const type of PROJECT_EVENT_TYPES) {
        source.addEventListener(type, handleProjectEvent as EventListener)
      }
      source.onerror = () => {
        // EventSource auto-reconnect is replaced with our own backed-off retry so
        // the cursor is carried and the status reflects the disconnect.
        source.close()
        if (sourceRef.current === source) sourceRef.current = null
        if (disposed) return
        setStatus('closed')
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      disposed = true
      clearReconnect()
      if (sourceRef.current !== null) {
        sourceRef.current.close()
        sourceRef.current = null
      }
    }
  }, [slug, queryClient])

  return status
}
