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

  /**
   * Dropping "Leave empty to keep" for masked dots inverted the contradiction
   * rather than removing it: eight bullets render in the same grey as the
   * "default" placeholder in the Username box beside it, so the field reads as
   * holding an 8-character stored password — directly above the hint
   * "Password: not set." (tripl-s8rg). The empty state has to say, in words,
   * that it is empty.
   */
  it('spells out the empty state instead of showing masked dots', () => {
    const placeholder = renderEdit(false).getAttribute('placeholder') ?? ''

    expect(placeholder).toBe('No password stored')
    expect(placeholder).not.toMatch(/[•*·]/)
  })
})
