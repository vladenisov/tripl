import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import AuthPage from './AuthPage'

function renderAuth() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/auth']}>
        <AuthPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AuthPage', () => {
  it('shows sign-in copy in the card header by default (login mode)', () => {
    renderAuth()

    expect(
      screen.getByRole('heading', { name: 'Sign in to tripl' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Use your account to access the workspace and monitoring tools.'),
    ).toBeInTheDocument()
  })

  it('updates the card title and subtitle to registration copy when Create Account is active (UX-22)', () => {
    renderAuth()

    // The register tab is the only "Create Account" control while login mode is active.
    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }))

    expect(
      screen.getByRole('heading', { name: 'Create your tripl account' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Set up your account to start tracking coverage, monitoring drift, and routing alerts.',
      ),
    ).toBeInTheDocument()
    // Login-only copy is gone once registration mode is active.
    expect(
      screen.queryByRole('heading', { name: 'Sign in to tripl' }),
    ).not.toBeInTheDocument()
  })

  it('restores the sign-in copy when switching back to Existing Account', () => {
    renderAuth()

    fireEvent.click(screen.getByRole('button', { name: 'Create Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Existing Account' }))

    expect(
      screen.getByRole('heading', { name: 'Sign in to tripl' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Create your tripl account' }),
    ).not.toBeInTheDocument()
  })
})
