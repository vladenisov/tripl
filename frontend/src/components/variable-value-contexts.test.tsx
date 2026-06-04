import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VariableValueContextTrigger } from './variable-value-contexts'

describe('VariableValueContextTrigger', () => {
  it('shows low-cardinality values in the popover', async () => {
    render(
      <VariableValueContextTrigger
        contexts={[
          {
            id: 'ctx-1',
            variable_id: 'var-1',
            variable_name: 'user_id',
            source_column: 'user_id',
            value_kind: 'low',
            observed_count: 2,
            values: ['u1', 'u2'],
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Observed variable values' }))

    expect(await screen.findByText('${user_id}')).toBeInTheDocument()
    expect(screen.getByText('All values')).toBeInTheDocument()
    expect(screen.getByText('u1')).toBeInTheDocument()
    expect(screen.getByText('u2')).toBeInTheDocument()
  })
})
