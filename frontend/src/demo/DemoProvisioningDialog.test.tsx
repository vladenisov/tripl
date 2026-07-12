import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { DemoProvisioningDialog } from './DemoProvisioningDialog'

function renderDialog(props: Partial<React.ComponentProps<typeof DemoProvisioningDialog>> = {}) {
  return render(
    <DemoProvisioningDialog
      status="provisioning"
      phaseIndex={0}
      error={null}
      timedOut={false}
      onRetry={() => {}}
      onCancel={() => {}}
      onClose={() => {}}
      {...props}
    />,
  )
}

describe('DemoProvisioningDialog', () => {
  it('shows staged progress and announces the current phase (a11y)', () => {
    renderDialog({ phaseIndex: 1 })

    // Every expected phase is listed…
    expect(screen.getByText('Creating workspace')).toBeInTheDocument()
    expect(screen.getByText('Seeding events')).toBeInTheDocument()
    expect(screen.getByText('Finalizing')).toBeInTheDocument()
    // …and the live region narrates the active one for screen readers.
    const live = screen.getByRole('status')
    expect(live).toHaveTextContent('Seeding events')
  })

  it('lets the user abandon an in-flight create (tripl-2su6.15)', () => {
    // The dialog used to be un-dismissable while pending, so a stalled request
    // left a page reload as the only way out. It is abandonable now: both the
    // close (X) button and the footer Cancel abort the request.
    const onCancel = vi.fn()
    renderDialog({ onCancel })

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('renders a human error with a Retry action on 500', () => {
    const onRetry = vi.fn()
    renderDialog({
      status: 'error',
      error: new ApiError('Demo provisioning failed and was rolled back.', 500),
      onRetry,
    })

    expect(screen.getByRole('alert')).toHaveTextContent('rolled back')
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('does not claim a rollback when the request merely timed out', () => {
    // A timeout aborts OUR request; the server may still be seeding. Promising
    // "nothing was left behind" here would be a lie.
    renderDialog({
      status: 'error',
      timedOut: true,
      error: new ApiError('Request to the backend timed out.', 408),
    })

    expect(screen.getByText(/may still be finishing on the server/i)).toBeInTheDocument()
    expect(screen.queryByText(/rolled back/i)).not.toBeInTheDocument()
  })
})
