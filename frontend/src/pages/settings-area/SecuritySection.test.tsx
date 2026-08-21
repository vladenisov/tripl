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

    const card = screen.getByText(/can't change your password here yet/i)
    expect(card).toHaveTextContent(/Forgot your password/i)
    // The old copy claimed a consequence of an action that never happened.
    expect(screen.queryByText(/signs out other sessions/i)).toBeNull()
    // …and said it in developer speak on the page a worried reader most needs
    // plain instructions on (tripl-91j6).
    expect(screen.queryByText(/wired up/i)).toBeNull()
  })

  it('leaves every other unbuilt control disabled too', () => {
    render(<SecuritySection />)

    expect(screen.getByRole('switch', { name: 'Authenticator app' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Regenerate/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Sign out other devices/ })).toBeDisabled()
  })

  /**
   * "Strongly recommended for owners." sat one line below "Not available yet on
   * this instance.", beside a switch nobody can move: the card told an owner to
   * turn on a protection the server cannot offer (tripl-91j6).
   */
  it('never recommends a protection the instance cannot switch on', () => {
    render(<SecuritySection />)

    expect(screen.getByText(/Not available yet on this instance/i)).toBeInTheDocument()
    expect(screen.queryByText(/recommended/i)).toBeNull()
  })

  /**
   * Active sessions rendered one hardcoded row reading "Current location · —" —
   * a label where a value belongs and an em dash for an IP — under a header
   * inviting the reader to review where the account is signed in (tripl-91j6).
   */
  it('shows no fabricated device row in Active sessions', () => {
    render(<SecuritySection />)

    expect(screen.queryByText(/Current location/i)).toBeNull()
    expect(screen.getByText('This device')).toBeInTheDocument()
  })

  /**
   * "Sign out all" sat directly beside "Signing out everywhere keeps this
   * device." — the button and the sentence explaining it disagreed about
   * whether this browser survives (tripl-91j6).
   */
  it('labels the sign-out control the way the sentence beside it reads', () => {
    render(<SecuritySection />)

    expect(screen.queryByRole('button', { name: /Sign out all/i })).toBeNull()
    expect(screen.getByText(/Signing out other devices would leave this one signed in/i))
      .toBeInTheDocument()
  })
})
