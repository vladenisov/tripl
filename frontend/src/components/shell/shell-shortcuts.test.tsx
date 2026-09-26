import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MAIN_CONTENT_ID } from '@/components/landmarks'
import ShortcutsDialog from './shortcuts-dialog'
import { findCreateAction, useShellShortcuts } from './shell-shortcuts'

function Harness({ onOpenHelp, children }: { onOpenHelp: () => void; children: ReactNode }) {
  useShellShortcuts({ onOpenHelp })
  return <main id={MAIN_CONTENT_ID}>{children}</main>
}

function renderPage(children: ReactNode) {
  const onOpenHelp = vi.fn()
  render(<Harness onOpenHelp={onOpenHelp}>{children}</Harness>)
  return { onOpenHelp }
}

describe('shell shortcuts (JR-21)', () => {
  it('presses the page\'s "New …" button on c', () => {
    const create = vi.fn()
    renderPage(
      <>
        <button type="button">Export</button>
        <button type="button" onClick={create}>New event</button>
      </>,
    )
    fireEvent.keyDown(document.body, { key: 'c' })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('prefers a control marked data-create-action', () => {
    const marked = vi.fn()
    const named = vi.fn()
    renderPage(
      <>
        <button type="button" onClick={named}>New thing</button>
        <button type="button" data-create-action="" onClick={marked}>Add rule</button>
      </>,
    )
    fireEvent.keyDown(document.body, { key: 'c' })
    expect(marked).toHaveBeenCalledTimes(1)
    expect(named).not.toHaveBeenCalled()
  })

  it('leaves letters alone while typing, with a modifier, or under a dialog', () => {
    const create = vi.fn()
    renderPage(
      <>
        <input aria-label="Name" />
        <button type="button" onClick={create}>New event</button>
      </>,
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'c' })
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'c', metaKey: true })
    expect(create).not.toHaveBeenCalled()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    fireEvent.keyDown(document.body, { key: 'c' })
    dialog.remove()
    expect(create).not.toHaveBeenCalled()
  })

  it('skips a disabled or hidden create control', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<button disabled>New a</button><div hidden><button>New b</button></div><a href="/x">New c</a>'
    expect(findCreateAction(root)?.textContent).toBe('New c')
    expect(findCreateAction(null)).toBeNull()
  })

  it('opens the shortcut sheet on ?', () => {
    const { onOpenHelp } = renderPage(<p>Page</p>)
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(onOpenHelp).toHaveBeenCalledTimes(1)
  })
})

describe('ShortcutsDialog', () => {
  it('lists every key the app answers to', () => {
    render(<ShortcutsDialog open onOpenChange={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' })
    for (const text of [
      'Search or jump to a page',
      'Search the list on this page',
      'Create on this page (New event, New metric…)',
      'Show these shortcuts',
    ]) {
      expect(dialog).toHaveTextContent(text)
    }
  })
})
