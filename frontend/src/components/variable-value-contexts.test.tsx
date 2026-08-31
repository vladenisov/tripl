import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { EventFieldVariableValue } from '@/types'
import { VariableValueContextTrigger } from './variable-value-contexts'

function context(overrides: Partial<EventFieldVariableValue> = {}): EventFieldVariableValue {
  return {
    id: 'ctx-1',
    variable_id: 'var-1',
    variable_name: 'user_id',
    source_column: 'user_id',
    value_kind: 'high',
    observed_count: 0,
    values: [],
    ...overrides,
  }
}

function openPopover() {
  fireEvent.click(screen.getByRole('button', { name: 'Observed variable values' }))
}

describe('VariableValueContextTrigger', () => {
  it('shows low-cardinality values in the popover', async () => {
    render(
      <VariableValueContextTrigger
        contexts={[context({ value_kind: 'low', observed_count: 2, values: ['u1', 'u2'] })]}
      />,
    )

    openPopover()

    expect(await screen.findByText('${user_id}')).toBeInTheDocument()
    expect(screen.getByText('All values')).toBeInTheDocument()
    expect(screen.getByText('u1')).toBeInTheDocument()
    expect(screen.getByText('u2')).toBeInTheDocument()
  })

  it('reports the empty context as this event field having no recorded value', async () => {
    render(<VariableValueContextTrigger contexts={[context()]} />)

    openPopover()

    expect(
      await screen.findByText('No value recorded for this field on this event'),
    ).toBeInTheDocument()
    // Nothing was counted, so there is no sample for "Examples" to name.
    expect(screen.getByText('No values')).toBeInTheDocument()
    expect(screen.queryByText('Examples')).not.toBeInTheDocument()
    expect(screen.queryByText('No examples stored')).not.toBeInTheDocument()
  })

  it('does not widen an empty context into a claim about the binding', async () => {
    // A sibling context of the same variable and the same source path can hold
    // the values this one lacks, so the empty line may speak for its own event
    // field and no wider: here the binding demonstrably has stored values.
    render(
      <VariableValueContextTrigger
        contexts={[
          context({ id: 'ctx-filled', observed_count: 2, values: ['u1', 'u2'] }),
          context({ id: 'ctx-empty' }),
        ]}
      />,
    )

    openPopover()

    const empty = await screen.findByText('No value recorded for this field on this event')
    // "binding" also names an editable Variable field, and the source path is
    // already on screen two lines up.
    expect(empty.textContent).not.toMatch(/binding/i)
    expect(screen.queryByText(/nothing has stored/i)).not.toBeInTheDocument()
    expect(screen.getByText('u1')).toBeInTheDocument()
  })

  it('keeps "No examples stored" when values were counted but none kept', async () => {
    render(<VariableValueContextTrigger contexts={[context({ observed_count: 9421 })]} />)

    openPopover()

    expect(await screen.findByText('No examples stored')).toBeInTheDocument()
    // "Examples" stays over this empty list: the observation is real, and only
    // the sample under the badge is missing.
    expect(screen.getByText('Examples')).toBeInTheDocument()
    expect(
      screen.queryByText('No value recorded for this field on this event'),
    ).not.toBeInTheDocument()
  })

  it('renders nothing when the field references no variable', () => {
    // The overwhelming majority of event fields are literals. A marker on every
    // one of them would bury the fields that do carry a variable.
    const { container } = render(<VariableValueContextTrigger contexts={[]} />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Observed variable values' })).toBeNull()
  })

  it('renders nothing when the caller omits contexts entirely', () => {
    const { container } = render(<VariableValueContextTrigger />)

    expect(container).toBeEmptyDOMElement()
  })
})
