import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Badge } from './badge'

describe('Badge danger tone (DS-37)', () => {
  it('draws a red state on the soft danger fill, not the solid count fill', () => {
    render(
      <>
        <Badge variant="danger">Failed</Badge>
        <Badge variant="destructive">3</Badge>
      </>,
    )

    // jsdom paints no Tailwind, so the variant is read off its token classes.
    expect(screen.getByText('Failed')).toHaveClass('bg-danger-soft', 'text-danger')
    expect(screen.getByText('Failed')).not.toHaveClass('bg-destructive')
    expect(screen.getByText('3')).toHaveClass('bg-destructive')
  })
})
