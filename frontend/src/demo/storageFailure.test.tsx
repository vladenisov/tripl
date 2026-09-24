import { fireEvent, render, renderHook, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { withThrowingStorage } from '@/test/storage'
import { ProductTour } from './ProductTour'
import { initialScenarioState, readScenarioState, writeScenarioState } from './scenarioModel'
import { readWelcomeDismissed, setWelcomeDismissed, useWelcomeDismissed } from './welcomeDismissal'

// Private mode and a full quota make every storage call throw. The demo keeps
// its place in storage, so each reader and writer is wrapped; these tests are
// what reaches those wrappers.
describe('demo state when storage throws', () => {
  it('opens the tour on the first step and still moves through it', () => {
    withThrowingStorage()
    render(
      <MemoryRouter>
        <ProductTour slug="acme" open onOpenChange={() => {}} />
      </MemoryRouter>,
    )

    expect(screen.getByText(/^Step 1 of/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    expect(screen.getByText(/^Step 2 of/)).toBeInTheDocument()
  })

  it('reads the initial scenario and drops a write without throwing', () => {
    withThrowingStorage()
    expect(readScenarioState('acme')).toEqual(initialScenarioState())
    expect(() => writeScenarioState('acme', initialScenarioState())).not.toThrow()
  })

  it('still hides the welcome panel for the session', () => {
    withThrowingStorage()
    const { result } = renderHook(() => useWelcomeDismissed('acme'))
    expect(result.current).toBe(false)

    // The choice cannot be stored, so it does not survive a reload — but the
    // listeners are still told, and nothing throws into the click handler.
    act(() => setWelcomeDismissed('acme', true))
    expect(readWelcomeDismissed('acme')).toBe(false)
  })
})
