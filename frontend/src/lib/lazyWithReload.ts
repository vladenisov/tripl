import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

// One reload is allowed to recover from a chunk that no longer exists; the flag
// makes sure a genuinely broken build cannot put the tab in a reload loop.
export const CHUNK_RELOAD_KEY = 'tripl:chunk-reload'

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
  remove(key: string): void {
    try {
      sessionStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  },
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
 * re-fetches index.html and with it the current graph. A successful import
 * re-arms the guard, so the next deploy is covered too. Where sessionStorage is
 * unavailable the guard cannot be kept, so there is no reload: the original
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
    factory()
      .then((module) => {
        safeSession.remove(CHUNK_RELOAD_KEY)
        return module
      })
      .catch((error: unknown) => {
        if (safeSession.read(CHUNK_RELOAD_KEY) !== null) throw error
        if (!safeSession.write(CHUNK_RELOAD_KEY, '1')) throw error
        window.location.reload()
        // The reload replaces the document, so this promise intentionally never
        // settles — resolving would flash an error UI on the way out.
        return new Promise<never>(() => {})
      }),
  )
}
