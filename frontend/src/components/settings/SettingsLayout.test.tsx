import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SettingsLayout } from './SettingsLayout'
import { WORKSPACE_GROUPS } from './nav'

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
      <SettingsLayout activePath={activePath} onNavigate={vi.fn()} backHref="/">
        <div>content</div>
      </SettingsLayout>
    </MemoryRouter>,
  )
}

describe('SettingsLayout nav accessibility', () => {
  it('gives the icon-led AI instance nav button an accessible name', () => {
    renderSettings('instance/ai')

    expect(screen.getByRole('button', { name: 'AI' })).toBeInTheDocument()
  })

  it('every Instance settings nav button has an accessible name', () => {
    renderSettings('instance/runtime')

    const instance = WORKSPACE_GROUPS.find((group) => group.label === 'Instance')
    expect(instance).toBeDefined()

    for (const item of instance!.items) {
      expect(item.label.trim().length).toBeGreaterThan(0)
      expect(screen.getByRole('button', { name: item.label })).toBeInTheDocument()
    }
  })
})
