import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PlanRulesSection from './PlanRulesSection'

/**
 * Nothing on Plan rules is wired to anything. The page still rendered every
 * control live and pre-set to a governed state — naming enforced, review
 * required, an owner required, 1 approval — so an owner could read it as proof
 * their tracking plan was protected (tripl-x2ho).
 *
 * These assertions are about what the page claims, not about how it is styled:
 * a control that is off and disabled cannot claim a guardrail is running, in
 * any theme or at any contrast setting. The appearance of "disabled" is the
 * kit's job (components/settings/input-style.ts).
 */
describe('Project · Plan rules states that none of it is built', () => {
  it('renders no switch that claims a guardrail is on', () => {
    render(<PlanRulesSection />)

    const switches = screen.getAllByRole('switch')
    expect(switches.length).toBeGreaterThan(0)
    for (const control of switches) {
      expect(control).toBeDisabled()
      expect(control).toHaveAttribute('aria-checked', 'false')
    }
  })

  it('leaves every case style unselected and every other control dead', () => {
    render(<PlanRulesSection />)

    const radios = screen.getAllByRole('radio')
    expect(radios.length).toBeGreaterThan(0)
    for (const radio of radios) {
      expect(radio).toBeDisabled()
      expect(radio).toHaveAttribute('aria-checked', 'false')
    }

    for (const box of screen.getAllByRole('textbox')) expect(box).toBeDisabled()
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled()
  })

  it('says so in the header instead of in a card footer', () => {
    render(<PlanRulesSection />)

    expect(screen.getByText('Not built yet')).toBeInTheDocument()
    expect(screen.getByText(/None of them run today/i)).toBeInTheDocument()
    // The footers held the only warning and a Save that could never fire. A
    // disabled Save argues the values above it are settings; they are not.
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
  })

  it('shows no approval quota or retention window as if it were set', () => {
    render(<PlanRulesSection />)

    expect(screen.queryByDisplayValue('1 approval')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('90 days')).not.toBeInTheDocument()
  })
})
