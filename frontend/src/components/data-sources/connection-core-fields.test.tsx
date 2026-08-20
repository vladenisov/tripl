import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ConnectionCoreFields } from './connection-core-fields'
import { EMPTY_CONNECTION_CORE_FORM } from './connection-core'

function renderEdit(secretSet: boolean): HTMLElement {
  render(
    <ConnectionCoreFields
      idPrefix="edit"
      dbType="clickhouse"
      value={EMPTY_CONNECTION_CORE_FORM}
      onChange={() => {}}
      mode="edit"
      secretSet={secretSet}
    />,
  )
  return screen.getByLabelText('Password')
}

describe('Edit dialog password field', () => {
  /**
   * The placeholder was gated on `isEdit` alone, so a source with no stored
   * password showed "Leave empty to keep" directly above a hint reading
   * "Password: not set." — two contradictory instructions about a credential,
   * five pixels apart (tripl-ofvc). The BigQuery key field one branch up had
   * always gated on `isEdit && secretSet`.
   */
  it('offers to keep a secret only when one is stored', () => {
    expect(renderEdit(true)).toHaveAttribute('placeholder', 'Leave empty to keep')
  })

  it('never offers to keep a secret that does not exist', () => {
    const field = renderEdit(false)

    expect(field.getAttribute('placeholder') ?? '').not.toMatch(/keep/i)
    expect(screen.getByText('Password: not set.')).toBeInTheDocument()
  })
})
