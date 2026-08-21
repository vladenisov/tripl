import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ColumnSuggestInput } from './column-suggest'

function renderInput(label: string, disabled: boolean) {
  render(
    <ColumnSuggestInput
      value=""
      onChange={() => {}}
      suggestions={['event_time']}
      aria-label={label}
      disabled={disabled}
    />,
  )
  return screen.getByLabelText(label)
}

describe('ColumnSuggestInput disabled treatment', () => {
  /**
   * The metric form's column boxes carried their own `opacity: 0.6` knock-down,
   * the same cue that on the dark theme left a dead field 3/255 of fill and
   * 7/255 of border from a live one — measurably no cue at all (tripl-91j6).
   * The guard is deliberately not a restatement of the shared primitive's
   * values: it pins that a disabled box does not look like a live one, and that
   * it is not dimming to say so.
   */
  it('does not answer "disabled" with an invisible dim', () => {
    const live = renderInput('Timestamp column', false)
    const dead = renderInput('Value column', true)

    expect(dead).toBeDisabled()
    expect(dead.getAttribute('style')).not.toBe(live.getAttribute('style'))
    expect(dead.style.opacity).toBe('')
  })
})
