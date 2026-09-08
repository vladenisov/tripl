import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SqlEditor } from './sql-editor'

describe('SqlEditor', () => {
  it('renders a ClickHouse editor with schema-aware SQL extensions', () => {
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={vi.fn()}
        dialect="clickhouse"
        tables={[
          {
            name: 'retention',
            columns: [{ name: 'device_id', data_type: 'String' }],
          },
        ]}
        ariaLabel="Fact metric SQL"
      />,
    )

    expect(screen.getByLabelText('Fact metric SQL')).toBeInTheDocument()
  })

  // tripl-h2sx.11: the Format button used to sit ON the editor, covering the
  // first line of any query wider than the box.
  it('puts Format under the editor rather than over it', () => {
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={vi.fn()}
        dialect="clickhouse"
        ariaLabel="Fact metric SQL"
      />,
    )

    const format = screen.getByRole('button', { name: 'Format' })
    expect(format).not.toHaveClass('absolute')
    expect(format.closest('.overflow-hidden')).toBeNull()
  })

  it('offers no Format row at all when the editor is read-only', () => {
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={vi.fn()}
        readOnly
        dialect="clickhouse"
        ariaLabel="Fact metric SQL"
      />,
    )

    expect(screen.queryByRole('button', { name: 'Format' })).toBeNull()
  })

  it('formats through the dialect formatter, not a re-indent', () => {
    const onChange = vi.fn()
    render(
      <SqlEditor
        value="select count() from retention"
        onChange={onChange}
        dialect="clickhouse"
        ariaLabel="Fact metric SQL"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Format' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const formatted = onChange.mock.calls[0][0] as string
    expect(formatted).toMatch(/\n/)
    expect(formatted.toLowerCase()).toContain('from')
  })
})
