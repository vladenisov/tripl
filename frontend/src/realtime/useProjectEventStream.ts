/**
 * Project event stream subscription hook (tripl-2su6.8).
 *
 * Opens an `EventSource` to `GET /api/v1/projects/{slug}/events/stream` and, on
 * each named event, invalidates the mapped React-Query keys (see
 * {@link ./invalidationMap}). One-way: server → client only.
 *
 * Reconnect: manual with jittered exponential backoff, carrying the
 * `Last-Event-ID` cursor as `?last_event_id=` so the server can replay missed
 * events. Coming back online or to a visible tab reconnects at once instead of
 * waiting out the timer. Duplicate delivery (replay, StrictMode remount) is
 * harmless — invalidation is idempotent — and additionally de-duplicated by
 * monotonic event id.
 *
 * Resync: the server's replay ring is small, and a Redis restart without
 * persistence starts the per-project sequence again at 1. So the first `hello`
 * after a reconnect refreshes every project cache the stream feeds, once, and
 * forgets the de-dupe high-water mark; an id far below that mark is read as a
 * sequence reset rather than as a stale duplicate. Without this, a reset left
 * every surface silently stale while the status still read `live`, which also
 * switches polling off.
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
/** ±30%, so clients dropped together by a deploy do not reconnect in lockstep. */
const BACKOFF_JITTER = 0.3
const HELLO_EVENT = 'hello'
/**
 * An id this far below the last one processed cannot be a replay — the
 * server's replay ring (backend/src/tripl/realtime.py `BUFFER_SIZE`) holds 50 —
 * so the sequence was reset.
 */
const SEQUENCE_RESET_GAP = 50

/** Backoff for the given attempt: exponential, capped, jittered. */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return Math.round(base * (1 - BACKOFF_JITTER + random() * 2 * BACKOFF_JITTER))
}

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
  // A `hello` was seen on this slug's stream before, so the next one follows a
  // reconnect and has to resync.
  const helloSeenRef = useRef(false)

  useEffect(() => {
    // Redis sequences are scoped per project. Carrying a previous project's
    // cursor into the new stream would make its low-numbered events look like
    // duplicates and can strand query caches until a full page reload.
    attemptsRef.current = 0
    lastEventIdRef.current = null
    lastProcessedIdRef.current = 0
    helloSeenRef.current = false
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
      const delay = reconnectDelay(attemptsRef.current)
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
        const last = lastProcessedIdRef.current
        const sequenceReset = last - id > SEQUENCE_RESET_GAP
        if (id <= last && !sequenceReset) return
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
      if (helloSeenRef.current) {
        // Back after a disconnect: whatever the replay cannot cover is
        // refetched, and events numbered from a restarted sequence count again.
        lastProcessedIdRef.current = 0
        for (const type of PROJECT_EVENT_TYPES) invalidateForEvent(queryClient, type, slug)
      }
      helloSeenRef.current = true
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

    // Waiting out a backoff timer after the laptop wakes or the network returns
    // could take 30 s; the browser says so directly, so reconnect right away.
    const reconnectNow = () => {
      if (disposed || sourceRef.current !== null) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      clearReconnect()
      attemptsRef.current = 0
      connect()
    }
    window.addEventListener('online', reconnectNow)
    document.addEventListener('visibilitychange', reconnectNow)

    connect()

    return () => {
      disposed = true
      window.removeEventListener('online', reconnectNow)
      document.removeEventListener('visibilitychange', reconnectNow)
      clearReconnect()
      if (sourceRef.current !== null) {
        sourceRef.current.close()
        sourceRef.current = null
      }
    }
  }, [slug, queryClient])

  return status
}
