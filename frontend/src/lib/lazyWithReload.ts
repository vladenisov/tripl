import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

// One reload is allowed to recover from a chunk that no longer exists. The key
// holds the time of the last chunk reload, so a genuinely broken build cannot
// put the tab in a reload loop: a second chunk failure inside the window below
// surfaces instead of reloading again.
export const CHUNK_RELOAD_KEY = 'tripl:chunk-reload'

/**
 * How long after a chunk reload another chunk failure counts as the same broken
 * deploy. Long enough to cover the reloaded document booting and requesting the
 * same chunk again; short enough that the next deploy, minutes or days later,
 * is still recovered by a reload.
 */
export const CHUNK_RELOAD_WINDOW_MS = 10_000

/**
 * sessionStorage access that never throws. With site data blocked (third-party
 * embedding under Chrome's cookie controls, some privacy modes) or the quota
 * full, every call raises — and a raise in the success path used to turn a
 * module that DID load into a rejected import, so no lazy route could render.
 * `undefined` from `read` means "storage unavailable": the guard cannot be kept.
 */
const safeSession = {
  read(key: string): string | null | undefined {
    try {
      return sessionStorage.getItem(key)
    } catch {
      return undefined
    }
  },
  write(key: string, value: string): boolean {
    try {
      sessionStorage.setItem(key, value)
      return true
    } catch {
      return false
    }
  },
}

/** True when a chunk reload already happened within {@link CHUNK_RELOAD_WINDOW_MS}. */
function reloadedRecently(stored: string | null): boolean {
  if (stored === null) return false
  const at = Number(stored)
  return Number.isFinite(at) && Date.now() - at < CHUNK_RELOAD_WINDOW_MS
}

/** True for the errors a browser raises when a lazy chunk cannot be fetched. */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch dynamically/i.test(
    error.message,
  )
}

/**
 * `React.lazy` that survives a deploy happening under an open tab.
 *
 * Every chunk filename carries a content hash, so a release replaces the whole
 * set. A tab loaded before the deploy still holds the OLD module graph and asks
 * for filenames the server no longer has — the request 404s and React surfaces
 * "Failed to fetch dynamically imported module", which is what a user hits the
 * first time they open any code-split route, settings section or chart after a
 * release.
 *
 * Server-side `Cache-Control` (backend/src/tripl/middleware/static_cache.py,
 * which sets `no-cache` on the shell) stops NEW page loads from booting a stale
 * shell, but it cannot help a document that is already running. Reloading once
 * re-fetches index.html and with it the current graph.
 *
 * Only a chunk-load failure reloads — any other rejection (a module that throws
 * while evaluating) would fail the same way after a reload. The guard is
 * time-based rather than cleared by a successful import: lazies nest (a page
 * lazily loads a chart, the SQL editor, a settings tab), so the page loading
 * fine says nothing about the nested chunk, and clearing the guard there let a
 * permanently missing nested chunk reload the tab forever. Where sessionStorage
 * is unavailable the guard cannot be kept, so there is no reload: the original
 * error propagates to the nearest error boundary, which offers one.
 */
// Mirrors React.lazy's own constraint. Narrowing it (e.g. ComponentType<unknown>)
// erases each page's props, so routes that pass `section`/`tab` stop
// typechecking — the wrapper must stay as permissive as what it wraps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    factory().catch((error: unknown) => {
        if (!isChunkLoadError(error)) throw error
        const stored = safeSession.read(CHUNK_RELOAD_KEY)
        if (stored === undefined || reloadedRecently(stored)) throw error
        if (!safeSession.write(CHUNK_RELOAD_KEY, String(Date.now()))) throw error
        window.location.reload()
        // The reload replaces the document, so this promise intentionally never
        // settles — resolving would flash an error UI on the way out.
        return new Promise<never>(() => {})
      }),
  )
}
