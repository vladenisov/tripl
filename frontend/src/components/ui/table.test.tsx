import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Table, TableBody, TableCell, TableRow } from './table'

describe('Table container', () => {
  it('carries the horizontal-overflow affordance on the element that scrolls', () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>cell</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    )

    // The wide events catalog scrolls inside this container, and its horizontal
    // scrollbar is far below the header row — `.tripl-scroll-x` paints the edge
    // fade that says "there is more to the right" (tripl-jfm3.36 / .70).
    const scroller = container.querySelector('[data-slot="table-container"]')
    expect(scroller).not.toBeNull()
    expect(scroller!.classList.contains('tripl-scroll-x')).toBe(true)
    expect(scroller!.classList.contains('overflow-x-auto')).toBe(true)
  })
})
