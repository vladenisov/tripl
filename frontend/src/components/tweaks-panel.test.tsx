import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThemeProvider } from './theme-provider'
import { TweaksPanelProvider } from './tweaks-panel'
import { useTweaksPanel } from './tweaks-panel-context'

function Opener() {
  const tweaks = useTweaksPanel()
  return (
    <button type="button" onClick={() => tweaks.setOpen(true)}>
      Appearance
    </button>
  )
}

function renderPanel() {
  return render(
    <ThemeProvider defaultTheme="dark" storageKey="tripl-ui-theme">
      <TweaksPanelProvider>
        <Opener />
      </TweaksPanelProvider>
    </ThemeProvider>,
  )
}

/** A controllable `prefers-color-scheme: dark` query. */
function installColorScheme(initialDark: boolean) {
  let matches = initialDark
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return matches
      },
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: (event: MediaQueryListEvent) => void) =>
        listeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  return (dark: boolean) => {
    matches = dark
    for (const cb of listeners) cb({ matches: dark } as MediaQueryListEvent)
  }
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
})

afterEach(() => {
  document.documentElement.className = ''
})

describe('TweaksPanel', () => {
  it('renders no floating trigger over the page (SHELL-35)', () => {
    renderPanel()
    expect(screen.queryByRole('button', { name: 'Open tweaks panel' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('moves focus in, closes on Escape and hands focus back', () => {
    renderPanel()
    const opener = screen.getByRole('button', { name: 'Appearance' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Appearance' })
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('closes on a click outside', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports the selected options with aria-pressed', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))

    const violet = screen.getByRole('button', { name: 'Violet' })
    expect(violet).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(violet)
    expect(violet).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Teal' })).toHaveAttribute('aria-pressed', 'false')

    const density = screen.getByRole('group', { name: 'Density' })
    expect(density.querySelector('[aria-pressed="true"]')).toHaveTextContent('Compact')
  })

  it('offers System, and a System theme follows the OS as it changes (SHELL-33)', () => {
    const setOsDark = installColorScheme(false)
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Appearance' }))

    const system = screen.getByRole('button', { name: 'System' })
    fireEvent.click(system)
    expect(system).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('tripl-ui-theme')).toBe('system')
    expect(document.documentElement).toHaveClass('light')

    act(() => setOsDark(true))
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement).not.toHaveClass('light')
  })
})
