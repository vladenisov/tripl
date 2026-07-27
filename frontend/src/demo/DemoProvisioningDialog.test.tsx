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

  it('surfaces the backend request id as a support reference on failure (.15)', () => {
    // The 500 carries a request id (echoed on the response header -> ApiError);
    // the dialog shows it so the user can quote it to support.
    renderDialog({
      status: 'error',
      error: new ApiError('Demo provisioning failed', 500, 'req-abc123'),
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Demo provisioning failed')
    expect(alert).toHaveTextContent('Reference: req-abc123')
  })

  it('announces the failure once — no duplicate title/status/alert copy (.15)', () => {
    // Regression: the failure sentence used to appear in the title, a polite
    // status region, AND the alert, so screen readers read it repeatedly. Now
    // the assertive alert is the only live region on the error path.
    renderDialog({
      status: 'error',
      error: new ApiError('Demo provisioning failed and was rolled back.', 500),
    })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('rolled back')
  })

  it('says so visibly on success and offers a positive action (tripl-jfm3.15)', () => {
    // Regression: the success frame kept the "Generating demo workspace" title
    // and a greyed-out Cancel; the only "ready" sentence was sr-only.
    renderDialog({ status: 'success', phaseIndex: 4 })

    expect(screen.getByText('Demo workspace is ready')).toBeInTheDocument()
    expect(screen.queryByText('Generating demo workspace')).not.toBeInTheDocument()
    const open = screen.getByRole('button', { name: /open demo/i })
    expect(open).toBeEnabled()
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument()
  })

  it('labels the phase list as an estimate while the request is open (tripl-jfm3.16)', () => {
    renderDialog({ phaseIndex: 3 })
    expect(screen.getByText(/estimated steps/i)).toBeInTheDocument()
  })

  it('confirms a cancel that actually stopped the create (tripl-jfm3.12)', () => {
    renderDialog({ status: 'cancelled', cancelOutcome: 'stopped' })

    expect(screen.getByText('Demo generation cancelled')).toBeInTheDocument()
    // Rendered both visibly and in the polite live region, hence getAllByText.
    expect(screen.getAllByText(/nothing was added to your projects/i).length).toBeGreaterThan(0)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('admits when a cancel arrived too late instead of implying a rollback (tripl-jfm3.12)', () => {
    renderDialog({ status: 'cancelled', cancelOutcome: 'already-finished' })

    expect(screen.getByText('Too late to cancel')).toBeInTheDocument()
    expect(screen.getAllByText(/will appear in your projects list/i).length).toBeGreaterThan(0)
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
