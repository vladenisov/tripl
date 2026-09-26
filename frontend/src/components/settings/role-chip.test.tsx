import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Role } from '@/types'
import { RoleChip } from './role-chip'

describe('RoleChip', () => {
  // One tone per role, app-wide (DS-7): Members and Profile must not drift.
  it.each<[Role, string, string]>([
    ['owner', 'Owner', 'accent'],
    ['editor', 'Editor', 'info'],
    ['viewer', 'Viewer', 'neutral'],
  ])('draws %s as "%s" in the %s tone', (role, label, tone) => {
    render(<RoleChip role={role} />)

    const chip = screen.getByText(label)
    expect(chip).toHaveAttribute('data-slot', 'chip')
    expect(chip).toHaveAttribute('data-tone', tone)
  })

  it('falls back to the raw role, in the neutral tone, for one it does not know', () => {
    render(<RoleChip role={'auditor' as unknown as Role} />)

    expect(screen.getByText('auditor')).toHaveAttribute('data-tone', 'neutral')
  })
})
