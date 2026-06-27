import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ColumnsMenu } from './ColumnsMenu'

function renderMenu(hiddenColumns: Set<string>) {
  return render(
    <ColumnsMenu
      open={false}
      onOpenChange={() => {}}
      tagsHidden={false}
      lastSeenHidden={false}
      fieldColumns={[]}
      metaFields={[]}
      hiddenColumns={hiddenColumns}
      onToggle={() => {}}
    />,
  )
}

describe('ColumnsMenu hidden-count badge', () => {
  it('labels the count clearly instead of an ambiguous "−N"', () => {
    renderMenu(new Set(['status', 'reviewed']))

    expect(screen.getByText('2 hidden')).toBeInTheDocument()
    expect(screen.queryByText('−2')).not.toBeInTheDocument()
  })

  it('omits the badge entirely when no columns are hidden', () => {
    renderMenu(new Set())

    expect(screen.queryByText(/hidden/)).not.toBeInTheDocument()
  })
})
