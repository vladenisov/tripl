import { render, screen } from '@testing-library/react'
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

describe('Account · Profile unbuilt controls', () => {
  /**
   * All six of these were live useState controls that persisted nowhere and
   * were read nowhere: a user set Date format to ISO, navigated away and back,
   * and it was gone with no message (tripl-z9ot).
   */
  it('renders the display preferences disabled instead of accepting input', () => {
    render(<ProfileSection />)

    expect(screen.getByLabelText('Timezone')).toBeDisabled()
    expect(screen.getByLabelText('Date format')).toBeDisabled()
    expect(screen.getByLabelText('Start of week')).toBeDisabled()
  })

  it('renders the notification switches disabled', () => {
    render(<ProfileSection />)

    for (const name of ['Incident alerts', 'Review requests', 'Weekly digest']) {
      expect(screen.getByRole('switch', { name })).toBeDisabled()
    }
  })

  /**
   * The card says timestamps follow "your browser's timezone for everyone" and
   * the control 58px below it read a hardcoded "Europe/Berlin": two adjacent
   * lines answering "what timezone are my timestamps in" differently, with the
   * wrong one rendered as this account's stored setting (tripl-hmlx).
   */
  it('shows the browser timezone the card promises, not a hardcoded city', () => {
    render(<ProfileSection />)

    expect(screen.getByLabelText('Timezone')).toHaveValue(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
  })

  it('drops the "saved on this device" promise nothing kept', () => {
    render(<ProfileSection />)

    expect(screen.queryByText(/saved on this device/i)).toBeNull()
    expect(screen.getAllByText(/Not available yet/i).length).toBeGreaterThan(1)
  })
})
