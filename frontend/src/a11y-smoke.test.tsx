import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'vitest-axe'

// Smoke test proving the vitest-axe harness is wired up correctly:
// the matcher is registered and axe-core runs against rendered DOM.
describe('a11y smoke harness', () => {
  it('reports no violations for an accessible button', async () => {
    const { container } = render(<button>Hello</button>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('detects violations for an inaccessible control', async () => {
    // An <img> with no alt text is a known axe violation, proving the
    // matcher actually flags problems rather than always passing.
    // eslint-disable-next-line jsx-a11y/alt-text -- intentionally invalid: this proves axe flags real violations
    const { container } = render(<img src="x.png" />)
    const results = await axe(container)
    expect(results.violations.length).toBeGreaterThan(0)
  })
})
