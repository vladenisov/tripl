import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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

describe('BigQuery key file input', () => {
  function renderBigQuery(onChange: (patch: unknown) => void) {
    render(
      <ConnectionCoreFields
        idPrefix="create"
        dbType="bigquery"
        value={EMPTY_CONNECTION_CORE_FORM}
        onChange={onChange}
        mode="create"
      />,
    )
    return screen.getByLabelText('Or load the key file')
  }

  it('loads the picked file into the key field', async () => {
    const onChange = vi.fn()
    const input = renderBigQuery(onChange)
    const file = new File(['{"type":"service_account"}'], 'key.json', { type: 'application/json' })
    // Pinned, so the test does not depend on jsdom's Blob.text().
    Object.defineProperty(file, 'text', {
      value: () => Promise.resolve('{"type":"service_account"}'),
    })

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ secret: '{"type":"service_account"}' }),
    )
    expect(screen.queryByText(/Could not read that file/)).not.toBeInTheDocument()
  })

  // A read that fails (file moved after it was picked, IO error) used to be an
  // unhandled rejection with no feedback at all.
  it('says so when the picked file cannot be read', async () => {
    const onChange = vi.fn()
    const input = renderBigQuery(onChange)
    const file = new File(['x'], 'key.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', {
      value: () => Promise.reject(new DOMException('gone', 'NotReadableError')),
    })

    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read that file')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onChange).not.toHaveBeenCalled()
  })
})
