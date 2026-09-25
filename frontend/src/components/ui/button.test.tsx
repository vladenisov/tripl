import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './button'

// jsdom resolves no Tailwind, so the disabled look can only be read off the
// classes the variant emits; theme-contrast.test.ts holds the inks it names
// to AA on the surfaces it names.
describe('Button disabled look (LIVE-32)', () => {
  it('turns a disabled primary button neutral instead of fading it', () => {
    render(<Button disabled>Save</Button>)

    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toBeDisabled()
    expect(button.className).not.toContain('opacity-50')
    expect(button.className).toContain('disabled:bg-[var(--surface-hover)]')
    expect(button.className).toContain('disabled:text-[var(--fg-muted)]')
  })

  it('keeps a disabled ghost button unfilled, with legible faint text', () => {
    render(<Button variant="ghost" disabled>Cancel</Button>)

    const button = screen.getByRole('button', { name: 'Cancel' })
    expect(button.className).not.toContain('opacity-50')
    expect(button.className).not.toContain('disabled:bg-')
    expect(button.className).toContain('disabled:text-[var(--fg-faint)]')
  })
})
