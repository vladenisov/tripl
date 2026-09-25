import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '@/components/error-boundary'
import { withThrowingStorage } from '@/test/storage'
import { CHUNK_RELOAD_KEY, isChunkLoadError, lazyWithReload } from './lazyWithReload'

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module: /assets/Page-abc.js')

function stubReload() {
  const reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, reload })
  return reload
}

function renderLazy(factory: () => Promise<{ default: () => React.ReactElement }>) {
  const Page = lazyWithReload(factory)
  return render(
    <ErrorBoundary>
      <Suspense fallback={<p>Loading</p>}>
        <Page />
      </Suspense>
    </ErrorBoundary>,
  )
}

beforeEach(() => {
  sessionStorage.clear()
})

describe('lazyWithReload', () => {
  it('reloads once when a chunk from a previous deploy is gone', async () => {
    const reload = stubReload()
    renderLazy(() => Promise.reject(chunkError()))

    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1')
  })

  it('does not loop: a second failure after the reload reaches the error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = stubReload()
    sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
    renderLazy(() => Promise.reject(chunkError()))

    expect(await screen.findByRole('button', { name: /Reload page/ })).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  // SHELL-7: with site data blocked every sessionStorage call throws. That used
  // to turn a module that DID load into a rejection, so no lazy page rendered.
  it('renders a loaded page when sessionStorage throws', async () => {
    withThrowingStorage()
    renderLazy(() => Promise.resolve({ default: () => <p>Loaded page</p> }))

    expect(await screen.findByText('Loaded page')).toBeInTheDocument()
  })

  it('surfaces the original error, without reloading, when storage cannot hold the guard', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    withThrowingStorage()
    const reload = stubReload()
    renderLazy(() => Promise.reject(chunkError()))

    expect(
      await screen.findByRole('heading', { name: 'The app needs a reload' }),
    ).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: /assets/x.js',
    'Importing a module script failed.',
    'error loading dynamically imported module: /assets/x.js',
  ])('recognises %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true)
  })

  it('ignores other errors', () => {
    expect(isChunkLoadError(new Error('t is not iterable'))).toBe(false)
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false)
  })
})
