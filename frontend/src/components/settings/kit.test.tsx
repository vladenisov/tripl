import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Field, Panel, SCard, Select, TextArea, TextInput } from './kit'

describe('Panel header', () => {
  /**
   * The clipping in tripl-jfm3.43 is pure layout, so the unit-level guard is
   * the class contract that produces it: a wrapping header whose right slot is
   * allowed to shrink, and a title that keeps a basis so it cannot collapse to
   * 0px behind the controls. Measured widths are covered by the browser pass.
   */
  function header(container: HTMLElement): HTMLElement {
    const found = container.querySelector('header')
    expect(found).not.toBeNull()
    return found as HTMLElement
  }

  it('wraps its controls instead of pinning them past the card edge', () => {
    const { container } = render(
      <Panel title="Catalog" subtitle="1 total" right={<button type="button">All kinds</button>}>
        <div>rows</div>
      </Panel>,
    )

    expect(header(container).className).toContain('flex-wrap')

    const rightSlot = header(container).lastElementChild as HTMLElement
    expect(rightSlot.textContent).toBe('All kinds')
    expect(rightSlot.className).not.toContain('shrink-0')
    expect(rightSlot.className).toContain('flex-wrap')
  })

  it('gives the title a basis so it cannot be crushed to zero width', () => {
    const { container } = render(
      <Panel title="Catalog" right={<button type="button">All kinds</button>}>
        <div>rows</div>
      </Panel>,
    )

    const titleColumn = header(container).firstElementChild as HTMLElement
    expect(titleColumn.textContent).toBe('Catalog')
    expect(titleColumn.className).toContain('basis-40')
  })
})

describe('Field label association', () => {
  /**
   * Field generated an id for its <label htmlFor> but rendered its children
   * raw, so unless a caller passed `htmlFor` AND repeated the id on its own
   * control the label addressed nothing — 10 of 14 inputs on
   * /settings/instance/ai had no accessible name (tripl-5gdg).
   */
  it('names an input, a textarea and a select the caller gave no id', () => {
    const noop = () => {}
    render(
      <>
        <Field label="Base URL">
          <TextInput value="https://example.com" onChange={noop} />
        </Field>
        <Field label="Ask prompt" stacked>
          <TextArea value="You are..." onChange={noop} />
        </Field>
        <Field label="Log level" last>
          <Select value="INFO" onChange={noop} options={['INFO', 'DEBUG']} />
        </Field>
      </>,
    )

    expect(screen.getByLabelText('Base URL')).toHaveValue('https://example.com')
    expect(screen.getByLabelText('Ask prompt')).toHaveValue('You are...')
    expect(screen.getByLabelText('Log level')).toHaveValue('INFO')
  })

  it('reaches a control nested below the immediate child', () => {
    // The secret fields wrap their input next to a "Clear" button, so the id
    // cannot be injected into the immediate child element.
    render(
      <Field label="AI API key">
        <div className="flex gap-2">
          <TextInput type="password" value="" onChange={() => {}} />
          <button type="button">Clear</button>
        </div>
      </Field>,
    )

    expect(screen.getByLabelText('AI API key')).toHaveAttribute('type', 'password')
  })

  it('gives the row id to one control only when a Field wraps several', () => {
    // The metric form's "Filters" row wraps a filter editor that renders two
    // Selects and a TextInput per condition. Handing all three the Field's id
    // put duplicate ids on focusable elements and left the label resolving to
    // whichever happened to come first in the DOM.
    const { container } = render(
      <Field label="Filters" stacked last>
        <Select value="a" onChange={() => {}} options={['a']} aria-label="Column" />
        <Select value="=" onChange={() => {}} options={['=']} aria-label="Operator" />
        <TextInput value="" onChange={() => {}} aria-label="Value" />
      </Field>,
    )

    const target = (container.querySelector('label') as HTMLLabelElement).htmlFor
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id)
    expect(ids.filter((id) => id === target)).toHaveLength(1)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('names a row that holds no control as a group instead of dangling its label', () => {
    // "Avatar" (two buttons), "Role" (a chip) and "Connection" (a test button)
    // have nothing a <label> can point at, so they opt out and name a group.
    const { container } = render(
      <Field label="Role" htmlFor={false} last>
        <span>Owner</span>
      </Field>,
    )

    expect(container.querySelector('label')).toBeNull()
    expect(screen.getByRole('group', { name: 'Role' })).toBeInTheDocument()
  })

  it('leaves an explicitly passed id alone', () => {
    render(
      <Field label="Self-service registration" htmlFor="security-registration-mode">
        <Select
          id="security-registration-mode"
          value="open"
          onChange={() => {}}
          options={['open', 'disabled']}
        />
      </Field>,
    )

    expect(screen.getByLabelText('Self-service registration')).toHaveAttribute(
      'id',
      'security-registration-mode',
    )
  })
})

describe('SCard header', () => {
  it('titles itself at h2 so settings pages read h1 → h2', () => {
    render(
      <SCard title="Project details" description="Identity and configuration.">
        <div>body</div>
      </SCard>,
    )

    expect(screen.getByRole('heading', { name: 'Project details', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
  })
})
