import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Variable } from '@/types'
import { JsonEditor } from './JsonEditor'

const VARIABLES: Variable[] = [
  {
    id: 'var-1',
    project_id: 'project-1',
    name: 'variant',
    source_name: null,
    variable_type: 'string',
    description: 'Experiment variant',
    allowed_values: ['control', 'treatment'],
    bindings: ['payload.variant'],
  },
]

describe('JsonEditor template authoring', () => {
  it('suggests canonical variables inside quoted JSON templates and accepts the value as valid JSON', () => {
    const onChange = vi.fn()
    render(<JsonEditor value="" onChange={onChange} variables={VARIABLES} />)

    const editor = screen.getByRole('combobox')
    fireEvent.change(editor, { target: { value: '{"variant":"${' } })

    expect(screen.getByRole('option', { name: /\$\{variant\}/ })).toBeInTheDocument()
    expect(screen.getByText('payload.variant')).toBeInTheDocument()
    expect(screen.getByText('control · treatment')).toBeInTheDocument()

    fireEvent.change(editor, { target: { value: '{"variant":"${variant}"}' } })
    expect(editor).toHaveAttribute('aria-invalid', 'false')
  })

  it('rejects malformed JSON even when it contains a valid variable token', () => {
    render(<JsonEditor value="" onChange={vi.fn()} variables={VARIABLES} />)

    const editor = screen.getByRole('combobox')
    fireEvent.change(editor, { target: { value: '{"variant":"${variant}",}' } })

    expect(editor).toHaveAttribute('aria-invalid', 'true')
  })

  it('rejects a variable token with JSON-breaking characters', () => {
    render(<JsonEditor value="" onChange={vi.fn()} variables={VARIABLES} />)

    const editor = screen.getByRole('combobox')
    fireEvent.change(editor, { target: { value: '{"variant": ${bad"token}}' } })

    expect(editor).toHaveAttribute('aria-invalid', 'true')
  })

  it('rejects variable templates used as object keys', () => {
    render(<JsonEditor value="" onChange={vi.fn()} variables={VARIABLES} />)

    const editor = screen.getByRole('combobox')
    fireEvent.change(editor, { target: { value: '{"${variant}": "control"}' } })

    expect(editor).toHaveAttribute('aria-invalid', 'true')
  })

  it('formats templates without replacing a matching literal sentinel value', () => {
    const onChange = vi.fn()
    render(
      <JsonEditor
        value={'{"literal":"\\u005f_TRIPL_VAR_1__","a":"${variant}","b":"${variant}"}'}
        onChange={onChange}
        variables={VARIABLES}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Format' }))

    expect(onChange).toHaveBeenCalledWith(
      '{\n  "literal": "__TRIPL_VAR_1__",\n  "a": "${variant}",\n  "b": "${variant}"\n}',
    )
  })
})
