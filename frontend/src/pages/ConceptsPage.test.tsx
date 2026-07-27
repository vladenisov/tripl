import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ConceptsPage from './ConceptsPage'

function renderConcepts() {
  return render(
    <MemoryRouter initialEntries={['/p/demo/concepts']}>
      <Routes>
        <Route path="/p/:slug/concepts" element={<ConceptsPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ConceptsPage', () => {
  it('frames the model with the three Plan / Observe / Govern areas', () => {
    renderConcepts()

    expect(screen.getByRole('heading', { name: 'Concepts' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /How tripl models your plan/ }),
    ).toBeInTheDocument()

    // Each area is named in the concept map and again as a glossary group, so it
    // must appear at least twice.
    for (const area of ['Plan', 'Observe', 'Govern']) {
      expect(screen.getAllByText(area).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('defines several key terms in the glossary', () => {
    renderConcepts()

    const keyTerms = [
      'Events',
      'Event types',
      'Schema & fields',
      'Variables',
      'Relations',
      'Monitors',
      'Signals',
      // The sidebar has an "Anomalies" surface; the glossary that claims to be
      // the naming authority has to define it (tripl-jfm3.39).
      'Anomalies',
      'Scopes',
      'Reconciliation',
      'Shadow events',
      'Dead events',
    ]
    for (const term of keyTerms) {
      expect(
        screen.getByRole('heading', { name: term, level: 3 }),
      ).toBeInTheDocument()
    }
  })

  it('does not claim a monitor raises signals (tripl-jfm3.39)', () => {
    renderConcepts()

    // The product raises signals from detection on every scan — a project with
    // zero monitors still shows open signals — so the glossary must not make a
    // monitor the cause of a signal.
    expect(screen.queryByText(/open anomaly raised by a monitor/i)).toBeNull()
    expect(screen.getByText(/no monitor has to exist for one to appear/i)).toBeInTheDocument()
    expect(screen.getByText(/a monitor decides which signals matter/i)).toBeInTheDocument()
  })

  it('links a term to where it lives in the app, scoped to the project slug', () => {
    renderConcepts()

    expect(screen.getByRole('link', { name: 'Open Events in the app' })).toHaveAttribute(
      'href',
      '/p/demo/events',
    )
    expect(
      screen.getByRole('link', { name: 'Open Reconciliation in the app' }),
    ).toHaveAttribute('href', '/p/demo/reconciliation')
    expect(screen.getByRole('link', { name: 'Open Monitors in the app' })).toHaveAttribute(
      'href',
      '/p/demo/monitors',
    )
  })
})
