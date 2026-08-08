import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ScanConfig } from '@/types'

import { ScanCausalNote } from './ScanCausalNote'

/** Only the two columns scanModeOf derives from matter here. */
function config(time_column: string | null, interval: string | null) {
  return { time_column, interval } as Pick<ScanConfig, 'time_column' | 'interval'>
}

function noteText(ui: React.ReactElement): string {
  const { unmount } = render(ui)
  const text = screen.getByTestId('scan-causal-note').textContent ?? ''
  unmount()
  return text
}

describe('ScanCausalNote — a scan says what it produces (tripl-3y7z.2)', () => {
  it('names metric points AND anomaly detection for a monitoring scan', () => {
    // The whole point of the note: the chain from a scan run to the Telegram
    // message. Dropping either half leaves the user with "Scan: Snowplow Events
    // (iOS)" in Telegram and no screen that connects it to the scan.
    const note = noteText(<ScanCausalNote variant="config" config={config('created_at', '1h')} />)

    expect(note).toContain('metric points')
    expect(note).toContain('anomaly detection')
    // The cadence is stated, lower-cased into the sentence.
    expect(note).toContain('Runs every hour.')
  })

  it('states the consequences a catalog-only scan does NOT have', () => {
    // Catalog only is a legitimate choice, so the note is not a warning — but it
    // must still say that no anomaly and no alert will ever come from this scan,
    // which is the silence the user would otherwise have to infer.
    expect(noteText(<ScanCausalNote variant="form" mode="catalog" />)).toContain(
      'no anomalies and sends no alerts',
    )
    expect(noteText(<ScanCausalNote variant="config" config={config(null, null)} />)).toContain(
      'no metric points, no anomalies, no alerts',
    )
  })

  it('says a scheduled scan with no time column never collects metrics', () => {
    // The misconfigured quadrant: the user asked for a schedule and gets
    // nothing. Collapsing it into "Catalog only" would launder the fault.
    const note = noteText(<ScanCausalNote variant="config" config={config(null, '1h')} />)

    expect(note).toContain('never collects metrics')
    expect(note).toContain('Add a time column to fix it.')
  })

  it('promises the whole chain in the form note for Catalog + monitoring', () => {
    const note = noteText(<ScanCausalNote variant="form" mode="monitoring" />)

    expect(note).toContain('record metric points every run')
    expect(note).toContain('raises signals; alerts are sent from signals')
  })

  it('follows the selected mode in the form variant', () => {
    const { rerender } = render(<ScanCausalNote variant="form" mode="monitoring" />)
    expect(screen.getByTestId('scan-causal-note')).toHaveTextContent('record metric points')

    rerender(<ScanCausalNote variant="form" mode="catalog" />)
    expect(screen.getByTestId('scan-causal-note')).toHaveTextContent('records no metric points')
  })

  it('tones only the fault as a warning', () => {
    const { rerender } = render(<ScanCausalNote variant="config" config={config('ts', '1d')} />)
    expect(screen.getByTestId('scan-causal-note')).toHaveStyle({ color: 'var(--fg-subtle)' })

    rerender(<ScanCausalNote variant="config" config={config(null, '1d')} />)
    expect(screen.getByTestId('scan-causal-note')).toHaveStyle({ color: 'var(--warning)' })

    // Catalog-only is a deliberate answer and must stay neutral.
    rerender(<ScanCausalNote variant="config" config={config(null, null)} />)
    expect(screen.getByTestId('scan-causal-note')).toHaveStyle({ color: 'var(--fg-subtle)' })
  })

  it('degrades to a cadence-free sentence for an interval it has no label for', () => {
    // A new interval added to the backend enum must not print a raw token.
    const note = noteText(<ScanCausalNote variant="config" config={config('ts', '30m')} />)

    expect(note).toContain('Runs on its schedule.')
    expect(note).not.toContain('30m')
  })
})
