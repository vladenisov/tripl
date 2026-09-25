import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn with the app type and radius scale (DS-20)', () => {
  it('keeps a scale size next to a colour class', () => {
    expect(cn('text-body-sm', 'text-fg-subtle')).toBe('text-body-sm text-fg-subtle')
    expect(cn('text-2xs', 'text-muted-foreground')).toBe('text-2xs text-muted-foreground')
  })

  it('lets a later size override an earlier one', () => {
    expect(cn('text-body-sm', 'text-caption')).toBe('text-caption')
    expect(cn('text-[12px]', 'text-title')).toBe('text-title')
  })

  it('treats the named radii as radii', () => {
    expect(cn('rounded-md', 'rounded-control')).toBe('rounded-control')
  })
})
