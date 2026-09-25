import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import type { AlertDestinationType } from '@/types'

import { ITEM_TEMPLATE_VARIABLE_OPTIONS, TEMPLATE_VARIABLE_OPTIONS } from './constants'
import { TemplateEditor } from './TemplateEditor'

function Harness({
  initial = '',
  destinationType = 'slack',
}: {
  initial?: string
  destinationType?: AlertDestinationType | null
}) {
  const [value, setValue] = useState(initial)
  return (
    <TemplateEditor
      destinationType={destinationType}
      messageFormat="plain"
      onMessageFormatChange={() => {}}
      title="Message Template"
      variableOptions={TEMPLATE_VARIABLE_OPTIONS}
      helperText="help"
      placeholder=""
      value={value}
      onChange={setValue}
    />
  )
}

/** Type into the textarea with the cursor at the end, as a keyboard would. */
function typeInto(textarea: HTMLElement, value: string) {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length } })
}

describe('TemplateEditor — the variable combobox works from the keyboard (ALR-19)', () => {
  it('moves through the suggestions with the arrows and inserts on Enter', () => {
    render(<Harness />)
    const textarea = screen.getByRole('combobox', { name: 'Message Template' })

    typeInto(textarea, '${rule')

    expect(textarea).toHaveAttribute('aria-expanded', 'true')
    const first = screen.getAllByRole('option')[0]!
    expect(first).toHaveAttribute('aria-selected', 'true')
    expect(textarea).toHaveAttribute('aria-activedescendant', first.id)

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(textarea).toHaveValue('${rule_name}')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('wraps ArrowUp to the last suggestion', () => {
    render(<Harness />)
    const textarea = screen.getByRole('combobox', { name: 'Message Template' })

    typeInto(textarea, '${')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })

    const options = screen.getAllByRole('option')
    expect(options.at(-1)).toHaveAttribute('aria-selected', 'true')
    expect(textarea).toHaveAttribute('aria-activedescendant', options.at(-1)!.id)
  })

  it('closes the list on Escape and leaves the text alone', () => {
    render(<Harness />)
    const textarea = screen.getByRole('combobox', { name: 'Message Template' })

    typeInto(textarea, 'Hi ${ru')
    fireEvent.keyDown(textarea, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(textarea).toHaveAttribute('aria-expanded', 'false')
    expect(textarea).toHaveValue('Hi ${ru')
  })
})

describe('TemplateEditor — labels (ALR-18)', () => {
  it('gives two editors on one form two distinct format labels', () => {
    render(
      <>
        <Harness />
        <Harness />
      </>,
    )

    const formats = screen.getAllByRole('combobox', { name: 'Message format' })
    expect(formats).toHaveLength(2)
    const ids = formats.map(trigger => trigger.getAttribute('aria-labelledby'))
    expect(new Set(ids).size).toBe(2)
  })

  it('offers no format until a destination is picked (ALR-4)', () => {
    render(<Harness destinationType={null} />)

    expect(screen.queryByRole('combobox', { name: 'Message format' })).toBeNull()
    expect(screen.getByText(/Pick a destination to choose a message format/)).toBeInTheDocument()
  })

  it('does not label a static note as "Message format" on the items editor', () => {
    render(
      <TemplateEditor
        destinationType="slack"
        messageFormat="plain"
        onMessageFormatChange={() => {}}
        title="Items Template"
        variableOptions={ITEM_TEMPLATE_VARIABLE_OPTIONS}
        helperText="help"
        showFormatSelector={false}
        placeholder=""
        value=""
        onChange={() => {}}
      />,
    )

    expect(screen.queryByText('Message format')).toBeNull()
  })
})

describe('TemplateEditor — unknown variables (ALR-21)', () => {
  it('names a typo under the editor, and ties it to the textarea', () => {
    render(<Harness initial="Rule ${rule_nme}" />)

    const textarea = screen.getByRole('combobox', { name: 'Message Template' })
    expect(screen.getByText(/Unknown variable \$\{rule_nme\}/)).toBeInTheDocument()
    expect(textarea).toHaveAccessibleDescription(/rule_nme/)
  })

  it('says nothing about a template that only uses known variables', () => {
    render(<Harness initial="Rule ${rule_name}" />)

    expect(screen.queryByText(/Unknown variable/)).toBeNull()
  })
})
