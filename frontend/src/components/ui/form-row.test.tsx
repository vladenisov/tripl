import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { Field, InfoRow, Panel } from '@/components/settings/kit'
import { EvField } from '@/pages/events/eventFormLayout'
import { SField, SurfPanel as EventTypesPanel } from '@/pages/settings/EventTypesTab'
import { Field as ScanField, SurfPanel as ScanPanel } from '@/pages/settings/scans/scanLayout'
import { FormRow } from './form-row'

// jsdom applies no Tailwind, so these pin the STRUCTURE the stacking layout
// hangs on — every labelled form row goes through the one shared primitive,
// whose classes stack below `sm` — rather than the class strings themselves.
describe('FormRow', () => {
  it('renders a caption column and a control column, with the caption width from sm up', () => {
    const { container } = render(
      <FormRow labelWidth={200} caption={<label htmlFor="x">Name</label>}>
        <input id="x" />
      </FormRow>,
    )

    const row = container.querySelector('[data-slot="form-row"]') as HTMLElement
    expect(row.style.getPropertyValue('--form-row-label')).toBe('200px')
    expect(row.querySelector('[data-slot="form-row-caption"]')).toHaveTextContent('Name')
    expect(row.querySelector('[data-slot="form-row-control"]')).toContainElement(
      screen.getByLabelText('Name'),
    )
  })
})

describe('forms that used a fixed-width caption now stack on phones (EVT-6 / DATA-8 / PLAN-35 / MON-32)', () => {
  const cases: [string, ReactNode][] = [
    ['event form row', <EvField label="Name" htmlFor="c"><input id="c" /></EvField>],
    ['scan form row', <ScanField label="Name" id="c"><input id="c" /></ScanField>],
    ['event-type form row', <SField label="Name"><input aria-label="Name" /></SField>],
    ['settings kit row', <Field label="Name" htmlFor="c"><input id="c" /></Field>],
  ]

  it.each(cases)('the %s is a shared FormRow', (_name, element) => {
    render(<>{element}</>)
    expect(screen.getByLabelText('Name').closest('[data-slot="form-row"]')).not.toBeNull()
  })

  it('stacks the read-only InfoRow too, and titles a value that may truncate', () => {
    render(<InfoRow label="Scan" value="A very long scan name that truncates" mono={false} />)
    const value = screen.getByText('A very long scan name that truncates')
    expect(value.closest('[data-slot="form-row"]')).not.toBeNull()
    expect(value).toHaveAttribute('title', 'A very long scan name that truncates')
  })
})

describe('panel bodies scroll sideways instead of clipping a wide table (DS-5 / DATA-9)', () => {
  const table = (
    <table aria-label="Wide">
      <tbody>
        <tr>
          <td>cell</td>
        </tr>
      </tbody>
    </table>
  )

  it.each([
    ['settings kit Panel', <Panel title="P">{table}</Panel>],
    ['scans SurfPanel', <ScanPanel title="P">{table}</ScanPanel>],
    ['event-types SurfPanel', <EventTypesPanel title="P">{table}</EventTypesPanel>],
  ])('the %s wraps its body in the scrolling panel body', (_name, element) => {
    render(<>{element}</>)
    expect(screen.getByRole('table', { name: 'Wide' }).closest('[data-slot="panel-body"]')).not.toBeNull()
  })
})
