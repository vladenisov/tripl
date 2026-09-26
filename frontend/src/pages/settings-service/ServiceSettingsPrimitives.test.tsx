import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InactiveGroup } from './ServiceSettingsPrimitives'

describe('InactiveGroup', () => {
  it('passes the rows through untouched while its switch is on', () => {
    const { container } = render(
      <InactiveGroup inactive={false} reason="Not used while AI is off.">
        <input aria-label="Model" />
      </InactiveGroup>,
    )

    expect(screen.getByLabelText('Model')).toBeEnabled()
    expect(screen.queryByText('Not used while AI is off.')).toBeNull()
    expect(container.querySelector('[data-inactive]')).toBeNull()
  })

  it('marks the rows inactive and says why, but leaves them editable', () => {
    const { container } = render(
      <InactiveGroup inactive reason="Not used while AI is off.">
        <input aria-label="Model" />
      </InactiveGroup>,
    )

    const group = container.querySelector('[data-inactive="true"]')
    expect(group).not.toBeNull()
    expect(group).toContainElement(screen.getByLabelText('Model'))
    expect(screen.getByText('Not used while AI is off.')).toBeInTheDocument()
    // De-emphasised, not disabled: preparing a config before switching it on is valid.
    expect(screen.getByLabelText('Model')).toBeEnabled()
  })

  it('draws no reason line when the card already says so', () => {
    const { container } = render(
      <InactiveGroup inactive>
        <input aria-label="Model" />
      </InactiveGroup>,
    )

    expect(container.querySelector('[data-inactive="true"]')).not.toBeNull()
    expect(container.querySelector('[data-inactive] > p')).toBeNull()
  })
})
