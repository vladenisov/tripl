import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Panel, SCard } from './kit'

describe('Panel header', () => {
  /**
   * The clipping in tripl-jfm3.43 is pure layout, so the unit-level guard is
   * the class contract that produces it: a wrapping header whose right slot is
   * allowed to shrink, and a title that keeps a basis so it cannot collapse to
   * 0px behind the controls. Measured widths are covered by the browser pass.
   */
  function header(container: HTMLElement): HTMLElement {
    const found = container.querySelector('header')
    expect(found).not.toBeNull()
    return found as HTMLElement
  }

  it('wraps its controls instead of pinning them past the card edge', () => {
    const { container } = render(
      <Panel title="Catalog" subtitle="1 total" right={<button type="button">All kinds</button>}>
        <div>rows</div>
      </Panel>,
    )

    expect(header(container).className).toContain('flex-wrap')

    const rightSlot = header(container).lastElementChild as HTMLElement
    expect(rightSlot.textContent).toBe('All kinds')
    expect(rightSlot.className).not.toContain('shrink-0')
    expect(rightSlot.className).toContain('flex-wrap')
  })

  it('gives the title a basis so it cannot be crushed to zero width', () => {
    const { container } = render(
      <Panel title="Catalog" right={<button type="button">All kinds</button>}>
        <div>rows</div>
      </Panel>,
    )

    const titleColumn = header(container).firstElementChild as HTMLElement
    expect(titleColumn.textContent).toBe('Catalog')
    expect(titleColumn.className).toContain('basis-40')
  })
})

describe('SCard header', () => {
  it('titles itself at h2 so settings pages read h1 → h2', () => {
    render(
      <SCard title="Project details" description="Identity and configuration.">
        <div>body</div>
      </SCard>,
    )

    expect(screen.getByRole('heading', { name: 'Project details', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
  })
})
