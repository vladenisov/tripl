import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('isMacPlatform', () => {
  it('detects Mac via navigator.platform', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' })
    const { isMacPlatform } = await import('./platform')
    expect(isMacPlatform()).toBe(true)
  })

  it('falls back to userAgent when platform is empty (iPad)', async () => {
    vi.stubGlobal('navigator', {
      platform: '',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)',
    })
    const { isMacPlatform } = await import('./platform')
    expect(isMacPlatform()).toBe(true)
  })

  it('returns false on Linux', async () => {
    vi.stubGlobal('navigator', {
      platform: 'Linux x86_64',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    })
    const { isMacPlatform } = await import('./platform')
    expect(isMacPlatform()).toBe(false)
  })

  it('returns false when navigator is undefined (SSR guard)', async () => {
    vi.stubGlobal('navigator', undefined)
    const { isMacPlatform } = await import('./platform')
    expect(isMacPlatform()).toBe(false)
  })
})

describe('commandPaletteShortcutLabel', () => {
  it('returns ⌘K on Mac', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' })
    vi.resetModules()
    const { commandPaletteShortcutLabel } = await import('./platform')
    expect(commandPaletteShortcutLabel()).toBe('⌘K')
  })

  it('returns Ctrl K on non-Mac (empty platform + non-Mac userAgent)', async () => {
    vi.stubGlobal('navigator', {
      platform: '',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    })
    vi.resetModules()
    const { commandPaletteShortcutLabel } = await import('./platform')
    expect(commandPaletteShortcutLabel()).toBe('Ctrl K')
  })
})
