import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SystemSettings } from '@/types'
import { SystemCard } from './SystemCard'

const HEALTHY: SystemSettings = {
  debug: false,
  database_url_configured: true,
  sync_database_url_configured: true,
  rabbitmq_url_configured: true,
  redis_url_configured: true,
  encryption_key_configured: true,
  openai_api_key_configured: true,
}

function renderCard(overrides: Partial<SystemSettings> = {}) {
  return render(<SystemCard system={{ ...HEALTHY, ...overrides }} />)
}

/** The tile whose uppercase label matches, so rows can be read independently. */
function tile(label: string): HTMLElement {
  const labelNode = screen.getByText(label)
  const element = labelNode.closest('div.flex-col')
  if (!element) throw new Error(`no tile around "${label}"`)
  return element as HTMLElement
}

describe('Instance System card', () => {
  /**
   * Every row used to render `active ? success : neutral`, so the two facts that
   * decide whether this instance is safe read backwards: debug mode ON was a
   * pulsing green "Configured", and a missing ENCRYPTION_KEY was the same
   * neutral "Unset" as the optional OpenAI fallback key (tripl-lgr4).
   */
  it('does not report debug mode as a configured, healthy state', () => {
    renderCard({ debug: true })

    const row = tile('Debug mode')
    expect(within(row).queryByText('Configured')).toBeNull()
    expect(within(row).getByText('On')).toBeInTheDocument()
    expect(row).toHaveTextContent(/startup checks are skipped/i)
  })

  it('says what a missing encryption key costs, unlike a missing optional key', () => {
    renderCard({ encryption_key_configured: false, openai_api_key_configured: false })

    expect(tile('Encryption key')).toHaveTextContent(/secrets are stored as plaintext/i)
    // Same word, "Unset" — the difference has to be in what each row says next.
    expect(tile('OpenAI fallback key')).toHaveTextContent(/Optional/i)
    expect(tile('OpenAI fallback key')).not.toHaveTextContent(/plaintext/i)
  })

  it('marks an unset optional dependency optional rather than missing', () => {
    renderCard({ redis_url_configured: false })

    expect(tile('Redis URL')).toHaveTextContent(/Optional/i)
    expect(tile('Redis URL')).not.toHaveTextContent(/Required/i)
  })

  it('calls an unset core dependency required', () => {
    renderCard({ rabbitmq_url_configured: false })

    expect(tile('RabbitMQ URL')).toHaveTextContent(/Required/i)
  })

  it('says these values are read from the environment, not editable here', () => {
    renderCard()

    expect(screen.getByText(/set the variable where the process gets its environment/i))
      .toBeInTheDocument()
  })
})
