import { vi } from 'vitest'

/**
 * Replaces `localStorage` and `sessionStorage` with stores whose every method
 * throws, the way Safari private mode or a full quota does. The in-memory
 * storage the test setup installs never throws, so without this the `try/catch`
 * around every storage call is code no test reaches. Undone after each test by
 * the setup's `vi.unstubAllGlobals()`.
 */
export function withThrowingStorage(): void {
  const fail = () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
  }
  const throwing = {
    get length(): number {
      return fail()
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  } as Storage
  vi.stubGlobal('localStorage', throwing)
  vi.stubGlobal('sessionStorage', throwing)
}
