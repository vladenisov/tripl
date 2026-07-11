import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { DemoProvisioningDialog } from './DemoProvisioningDialog'

describe('DemoProvisioningDialog', () => {
  it('shows staged progress and announces the current phase (a11y)', () => {
    render(
      <DemoProvisioningDialog
        status="provisioning"
        phaseIndex={1}
        error={null}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    )

    // Every expected phase is listed…
    expect(screen.getByText('Creating workspace')).toBeInTheDocument()
    expect(screen.getByText('Seeding events')).toBeInTheDocument()
    expect(screen.getByText('Finalizing')).toBeInTheDocument()
    // …and the live region narrates the active one for screen readers.
    const live = screen.getByRole('status')
    expect(live).toHaveTextContent('Seeding events')
  })

  it('is not dismissible while a create is in flight', () => {
    render(
      <DemoProvisioningDialog
        status="provisioning"
        phaseIndex={0}
        error={null}
        onRetry={() => {}}
        onClose={() => {}}
      />,
    )
    // No close (X) button is offered mid-provision.
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument()
  })

  it('renders a human error with a Retry action on 500', () => {
    const onRetry = vi.fn()
    render(
      <DemoProvisioningDialog
        status="error"
        phaseIndex={0}
        error={new ApiError('Demo provisioning failed and was rolled back.', 500)}
        onRetry={onRetry}
        onClose={() => {}}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('rolled back')
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
