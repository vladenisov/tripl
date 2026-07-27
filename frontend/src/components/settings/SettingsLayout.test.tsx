import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SettingsLayout } from './SettingsLayout'
import { WORKSPACE_GROUPS } from './nav'

// Mock the auth context so the layout renders as an owner (Instance group is
// owner-only) without pulling in the real provider/network.
vi.mock('@/components/auth-context', () => ({
  useAuth: () => ({
    user: {
      id: 'u1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      role: 'owner',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(),
  }),
}))

function renderSettings(activePath: string) {
  return render(
    <MemoryRouter>
      <SettingsLayout activePath={activePath} onNavigate={vi.fn()} backHref="/">
        <div>content</div>
      </SettingsLayout>
    </MemoryRouter>,
  )
}

describe('SettingsLayout signposting', () => {
  it('states the takeover area job in one line', () => {
    renderSettings('members')

    expect(screen.getByText('Workspace & account configuration')).toBeInTheDocument()
  })

  it('offers a labelled "Back to project" cross-link to the in-app surface', () => {
    render(
      <MemoryRouter>
        <SettingsLayout activePath="members" onNavigate={vi.fn()} backHref="/p/demo/events">
          <div>content</div>
        </SettingsLayout>
      </MemoryRouter>,
    )

    const back = screen.getByRole('link', { name: /Back to project/i })
    expect(back).toHaveAttribute('href', '/p/demo/events')
  })

  it('shows a short descriptor for each visible nav group', () => {
    renderSettings('members')

    expect(screen.getByText('Shared across everyone in the workspace')).toBeInTheDocument()
    expect(screen.getByText('Settings just for you')).toBeInTheDocument()
    expect(screen.getByText('Server-wide settings (owner only)')).toBeInTheDocument()
  })
})

describe('SettingsLayout nav accessibility', () => {
  it('gives the icon-led AI instance nav button an accessible name', () => {
    renderSettings('instance/ai')

    expect(screen.getByRole('button', { name: 'AI' })).toBeInTheDocument()
  })

  it('every Instance settings nav button has an accessible name', () => {
    renderSettings('instance/runtime')

    const instance = WORKSPACE_GROUPS.find((group) => group.label === 'Instance')
    expect(instance).toBeDefined()

    for (const item of instance!.items) {
      expect(item.label.trim().length).toBeGreaterThan(0)
      expect(screen.getByRole('button', { name: item.label })).toBeInTheDocument()
    }
  })
})

describe('SettingsLayout responsive rail', () => {
  /** The rail element — the only <aside> in this shell. */
  function rail(container: HTMLElement): HTMLElement {
    const found = container.querySelector('aside')
    expect(found).not.toBeNull()
    return found as HTMLElement
  }

  it('parks the rail off-canvas below md and pins it from md up', () => {
    const { container } = renderSettings('members')

    // Off-canvas by default (phones) but forced back into static flow at md, so
    // a 264px rail can never leave a 390px viewport a ~45px content column
    // (tripl-jfm3.40).
    expect(rail(container).className).toContain('-translate-x-full')
    expect(rail(container).className).toContain('md:static')
    expect(rail(container).className).toContain('md:translate-x-0')
  })

  it('opens and dismisses the rail from the phone-only hamburger', () => {
    const { container } = renderSettings('members')

    const open = screen.getByRole('button', { name: 'Open settings navigation' })
    expect(open).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(open)
    expect(rail(container).className).toContain('translate-x-0')
    expect(rail(container).className).not.toContain('-translate-x-full')

    fireEvent.click(screen.getByRole('button', { name: 'Close settings navigation' }))
    expect(rail(container).className).toContain('-translate-x-full')
  })

  it('closes the rail after picking a section so the content is visible', () => {
    const onNavigate = vi.fn()
    const { container } = render(
      <MemoryRouter>
        <SettingsLayout activePath="members" onNavigate={onNavigate} backHref="/">
          <div>content</div>
        </SettingsLayout>
      </MemoryRouter>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open settings navigation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Profile' }))

    expect(onNavigate).toHaveBeenCalledWith('profile')
    expect(rail(container).className).toContain('-translate-x-full')
  })
})

describe('SettingsLayout landmarks and headings', () => {
  it('offers a skip link to a focusable main landmark', () => {
    const { container } = renderSettings('members')

    const skip = screen.getByRole('link', { name: 'Skip to main content' })
    expect(skip).toHaveAttribute('href', '#settings-content')

    const main = container.querySelector('#settings-content')
    expect(main).not.toBeNull()
    expect(main).toHaveAttribute('tabindex', '-1')
  })

  it('names the rail nav without emitting an h2 above the page h1', () => {
    renderSettings('members')

    // The rail used to render <h2>Settings</h2> before every page's <h1>,
    // which opened the heading outline with a level-2 skip (tripl-jfm3.69).
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Settings' })).toBeInTheDocument()
  })
})
