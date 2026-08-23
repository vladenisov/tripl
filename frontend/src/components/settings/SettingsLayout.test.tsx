import { useEffect } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SettingsLayout } from './SettingsLayout'
import { WORKSPACE_GROUPS } from './nav'
import { useUnsavedChanges } from './unsaved-changes'

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
      <SettingsLayout activePath={activePath} backHref="/">
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
        <SettingsLayout activePath="members" backHref="/p/demo/events">
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
  it('gives the icon-led AI instance nav link an accessible name', () => {
    renderSettings('instance/ai')

    expect(screen.getByRole('link', { name: 'AI' })).toBeInTheDocument()
  })

  it('every Instance settings nav entry is a real link with an accessible name', () => {
    renderSettings('instance/runtime')

    const instance = WORKSPACE_GROUPS.find((group) => group.label === 'Instance')
    expect(instance).toBeDefined()

    for (const item of instance!.items) {
      expect(item.label.trim().length).toBeGreaterThan(0)
      // As <button>s none of these could be cmd-clicked into a new tab,
      // middle-clicked, hovered for a URL or copied (tripl-wd66).
      expect(screen.getByRole('link', { name: item.label })).toHaveAttribute(
        'href',
        `/settings/${item.path}`,
      )
    }
  })

  it('marks the active rail entry as the current page', () => {
    renderSettings('instance/storage')

    expect(screen.getByRole('link', { name: 'Storage' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'AI' })).not.toHaveAttribute('aria-current')
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
    const { container } = renderSettings('members')

    fireEvent.click(screen.getByRole('button', { name: 'Open settings navigation' }))
    fireEvent.click(screen.getByRole('link', { name: 'Profile' }))

    expect(rail(container).className).toContain('-translate-x-full')
  })
})

describe('SettingsLayout unsaved-changes guard', () => {
  const DRAFT_MESSAGE = 'Instance settings you edited here have not been saved.'

  /** Stands in for ServiceSettingsPage: a draft only the instance group keeps. */
  function InstanceDraft({ dirty = true }: { dirty?: boolean }) {
    const { registerUnsaved } = useUnsavedChanges()
    useEffect(() => {
      registerUnsaved(
        dirty ? { keptBy: (path) => path.startsWith('instance/'), message: DRAFT_MESSAGE } : null,
      )
      return () => registerUnsaved(null)
    }, [dirty, registerUnsaved])
    return <div>draft</div>
  }

  function draftShell(dirty: boolean) {
    return (
      <MemoryRouter>
        <SettingsLayout activePath="instance/ai" backHref="/p/demo/events">
          <InstanceDraft dirty={dirty} />
        </SettingsLayout>
      </MemoryRouter>
    )
  }

  function renderWithDraft() {
    return render(draftShell(true))
  }

  function reload(): Event {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event
  }

  it('warns before a rail link navigates the draft out of existence', async () => {
    renderWithDraft()

    fireEvent.click(screen.getByRole('link', { name: 'Profile' }))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Leave with unsaved changes?',
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(DRAFT_MESSAGE)
  })

  it('warns before "Back to project" leaves the settings area', async () => {
    renderWithDraft()

    fireEvent.click(screen.getByRole('link', { name: /Back to project/i }))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Leave with unsaved changes?',
    )
  })

  it('warns before the command palette navigates the draft out of existence', async () => {
    renderWithDraft()

    // Ctrl+K is live on every settings route, so it is a way out of the
    // takeover like any other and has to meet the same guard.
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const palette = await screen.findByRole('dialog')
    fireEvent.click(within(palette).getByText('Profile'))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      'Leave with unsaved changes?',
    )
    expect(screen.getByRole('alertdialog')).toHaveTextContent(DRAFT_MESSAGE)
  })

  it('stays silent when a palette destination keeps the draft', async () => {
    renderWithDraft()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const palette = await screen.findByRole('dialog')
    fireEvent.click(within(palette).getByText('Email'))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('warns before Sign out drops the draft', async () => {
    renderWithDraft()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(DRAFT_MESSAGE)
  })

  it('stays silent when the destination keeps the draft', () => {
    // AI → Email keeps ServiceSettingsPage mounted, so a prompt here would be
    // a false alarm on every section switch (tripl-l8v2).
    renderWithDraft()

    fireEvent.click(screen.getByRole('link', { name: 'Email' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('lets the browser prompt before a reload or tab close discards the draft', () => {
    // Neither is a React navigation, so the dialog above can never run for
    // them — only a beforeunload listener reaches them (tripl-l33u.6).
    renderWithDraft()

    expect(reload().defaultPrevented).toBe(true)
  })

  it('leaves reload alone while there is nothing to lose', () => {
    renderSettings('instance/ai')

    expect(reload().defaultPrevented).toBe(false)
  })

  it('stops prompting on reload once the draft is saved', () => {
    const { rerender } = render(draftShell(true))

    rerender(draftShell(false))

    expect(reload().defaultPrevented).toBe(false)
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
