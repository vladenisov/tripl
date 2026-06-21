import '@testing-library/jest-dom'
import { expect } from 'vitest'
import * as axeMatchers from 'vitest-axe/matchers'
import type { AxeMatchers } from 'vitest-axe/matchers'

// vitest-axe@0.1.0 ships an empty `extend-expect` entry, so register the
// axe matchers manually. This makes `expect(...).toHaveNoViolations()` work.
expect.extend(axeMatchers)

// The package's `extend-expect` type augmentation has a broken runtime import,
// so declare the matcher types against vitest's `Assertion` interface here.
// The `T = any` default must match vitest's own declaration exactly (TS2428).
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends AxeMatchers {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AsymmetricMatchersContaining extends AxeMatchers {}
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
