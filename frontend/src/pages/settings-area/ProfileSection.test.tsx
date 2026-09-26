import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ProfileSection from './ProfileSection'

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
    logout: vi.fn(),
    refresh: vi.fn(),
  }),
}))

describe('Account · Profile', () => {
  it('says once that nothing here is editable (#237 ST-17)', () => {
    render(<ProfileSection />)

    expect(screen.getByRole('note')).toHaveTextContent(/can't be changed here yet/)
  })

  it('shows the account’s real details', () => {
    render(<ProfileSection />)

    expect(within(screen.getByRole('group', { name: 'Name' })).getByText('Ada Lovelace'))
      .toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Email' })).getByText('ada@example.com'))
      .toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Role' })).getByText('Owner'))
      .toBeInTheDocument()
  })

  /**
   * The card says timestamps follow the browser's timezone, and the value beside
   * it used to read a hardcoded "Europe/Berlin" (tripl-hmlx).
   */
  it('shows the browser timezone, not a hardcoded city', () => {
    render(<ProfileSection />)

    expect(
      within(screen.getByRole('group', { name: 'Timezone' })).getByText(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
    ).toBeInTheDocument()
  })

  /**
   * WS-37: the unbuilt preferences and notifications were first live controls
   * that persisted nowhere (tripl-z9ot), then the same controls disabled. Now
   * they are one "Coming later" card with nothing to click.
   */
  it('names what is not built in one card without a single control', () => {
    render(<ProfileSection />)

    expect(screen.getByText('Coming later')).toBeInTheDocument()
    expect(screen.getByText('Personal notifications')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryByText(/saved on this device/i)).toBeNull()
  })
})
