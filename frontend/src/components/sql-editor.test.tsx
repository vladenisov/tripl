import { render, screen } from '@testing-library/react'
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
})
