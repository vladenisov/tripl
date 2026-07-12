import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'
import { expect } from 'vitest'
import * as axeMatchers from 'vitest-axe/matchers'
import type { AxeMatchers } from 'vitest-axe/matchers'

// vitest-axe@0.1.0 ships an empty `extend-expect` entry, so register the
// axe matchers manually. This makes `expect(...).toHaveNoViolations()` work.
expect.extend(axeMatchers)

// Testing Library's 1000ms default for `findBy*`/`waitFor` is too tight for the
// route-level tests: resolving a lazy route chunk and settling its first render
// can exceed it whenever the machine is busy (a loaded CI runner, or a backend
// suite competing for CPU locally), which shows up as flakes that never reproduce
// in isolation. The headroom only costs wall-clock on an assertion that was going
// to fail anyway.
configure({ asyncUtilTimeout: 5000 })

// The package's `extend-expect` type augmentation has a broken runtime import,
// so declare the matcher types against vitest's `Assertion` interface here.
// The `T = any` default must match vitest's own declaration exactly (TS2428).
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends AxeMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

// jsdom's `localStorage` varies by version — CI's build omits it entirely, so a
// test's `localStorage.clear()` throws, which aborts Testing Library's afterEach
// cleanup and leaks rendered DOM into later tests. Install a fresh in-memory
// Storage unconditionally so every test file behaves identically everywhere.
{
  const store = new Map<string, string>()
  const localStorageMock = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageMock as Storage,
    configurable: true,
    writable: true,
  })
}

if (!window.ResizeObserver) {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  window.ResizeObserver = ResizeObserverMock as typeof ResizeObserver
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver
}

if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {}
}
