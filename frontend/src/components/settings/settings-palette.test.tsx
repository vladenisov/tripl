import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_CONTENT_ID } from './landmarks'
import { visibleGroupsAll } from './nav'
import { SettingsCommandPalette } from './settings-palette'

const PROJECTS = [
  { name: 'Windy Android', slug: 'windy-android' },
  { name: 'Windy iOS', slug: 'windy-ios' },
]

function renderPalette(overrides: { isOwner?: boolean; backHref?: string } = {}) {
  const onLeave = vi.fn()
  const onSignOut = vi.fn()
  render(
    <>
      {/* The takeover's own content landmark — the palette's focus-restore
          target, since /settings/* never renders the shell's #main-content. */}
      <main id={SETTINGS_CONTENT_ID} tabIndex={-1}>
        section
      </main>
      <button type="button" data-testid="opener">
        Open
      </button>
      <SettingsCommandPalette
        activePath="instance/ai"
        backHref={overrides.backHref ?? '/p/windy-ios/events'}
        isOwner={overrides.isOwner ?? true}
        projects={PROJECTS}
        onLeave={onLeave}
        onSignOut={onSignOut}
      />
    </>,
  )
  return { onLeave, onSignOut }
}

async function openPalette(): Promise<HTMLElement> {
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
  return await screen.findByRole('dialog')
}

describe('Settings command palette destinations', () => {
  it('offers every settings section the rail lists, at its own path', async () => {
    const { onLeave } = renderPalette()

    const palette = await openPalette()
    for (const group of visibleGroupsAll(true)) {
      for (const item of group.items) {
        expect(within(palette).getByText(item.label)).toBeInTheDocument()
      }
    }

    fireEvent.click(within(palette).getByText('Storage'))

    // The settings path travels with the href so the shell's unsaved-changes
    // predicate can tell "still in the instance group" from "leaving it".
    expect(onLeave).toHaveBeenCalledWith('/settings/instance/storage')
  })

  it('hides owner-only sections from a non-owner, exactly as the rail does', async () => {
    renderPalette({ isOwner: false })

    const palette = await openPalette()

    expect(within(palette).getByText('Profile')).toBeInTheDocument()
    expect(within(palette).queryByText('Runtime')).toBeNull()
    expect(within(palette).queryByText('Observability')).toBeNull()
  })

  it('goes to the project it names rather than to the first one in the list', async () => {
    const { onLeave } = renderPalette()

    const palette = await openPalette()
    fireEvent.click(within(palette).getByText('Windy iOS'))

    // The app palette bound itself to `projects[0]` on these routes, because no
    // /settings/* route carries a :slug — so it searched Windy Android and
    // navigated into it from a takeover bound to Windy iOS.
    expect(onLeave).toHaveBeenCalledWith('/p/windy-ios/events')
  })

  it('offers nothing scoped to a project it cannot know it is in', async () => {
    renderPalette()

    const palette = await openPalette()
    fireEvent.change(within(palette).getByPlaceholderText(/Search settings/i), {
      target: { value: 'anomalies' },
    })

    // A settings route has no project in scope. Answering this query with some
    // project's Anomalies page — or its knowledge base — is a guess, and the
    // guess was always `projects[0]`.
    expect(within(palette).getByText('No matches.')).toBeInTheDocument()
  })

  it('routes Sign out through the shell so the leave-guard sees it', async () => {
    const { onSignOut } = renderPalette()

    const palette = await openPalette()
    fireEvent.click(within(palette).getByText('Sign out'))

    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})

describe('Settings command palette focus restore', () => {
  it('hands focus to the settings content instead of dropping it on <body>', async () => {
    renderPalette()

    // Nothing focused: the state a deep link or a reload leaves, where Radix's
    // own restore target is <body> and the next Tab restarts at the skip link,
    // ahead of the ~20-stop rail (tripl-jfm3.68).
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)

    await openPalette()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await waitFor(() => {
      expect(document.activeElement).toBe(document.getElementById(SETTINGS_CONTENT_ID))
    })
  })

  it('hands focus back to whatever opened it', async () => {
    renderPalette()

    const opener = screen.getByTestId('opener')
    opener.focus()

    await openPalette()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await waitFor(() => {
      expect(document.activeElement).toBe(opener)
    })
  })
})
