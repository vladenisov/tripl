import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import SecuritySection from './SecuritySection'

describe('Account · Security password card', () => {
  /**
   * The button used to enable as soon as both fields were non-empty and then
   * do nothing — no onClick, no type="submit", no form around it — so a user
   * left believing their password had rotated (tripl-2o74). Nothing on this
   * page may look actionable while nothing is wired to it.
   */
  it('never offers an actionable "Update password" control', () => {
    render(<SecuritySection />)

    expect(screen.getByRole('button', { name: 'Update password' })).toBeDisabled()
    expect(screen.getByLabelText('Current password')).toBeDisabled()
    expect(screen.getByLabelText('New password')).toBeDisabled()
  })

  it('points at the reset flow that does work instead of promising a rotation', () => {
    render(<SecuritySection />)

    const card = screen.getByText(/isn't wired up yet/i)
    expect(card).toHaveTextContent(/Forgot your password/i)
    // The old copy claimed a consequence of an action that never happened.
    expect(screen.queryByText(/signs out other sessions/i)).toBeNull()
  })

  it('leaves every other unbuilt control disabled too', () => {
    render(<SecuritySection />)

    expect(screen.getByRole('switch', { name: 'Authenticator app' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Sign out all/ })).toBeDisabled()
  })
})
