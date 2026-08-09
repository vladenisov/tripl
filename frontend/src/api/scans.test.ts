import { afterEach, describe, expect, it, vi } from 'vitest'
import { scansApi } from './scans'

// The real client is exercised; only global fetch is stubbed, so the messages
// asserted here are the ones ScanPreviewPanel actually renders.

const DRAFT = { data_source_id: 'ds-1', base_query: 'SELECT 1' }

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: '',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
  } as unknown as Response
}

function dryRunJob(overrides: Record<string, unknown>) {
  return {
    id: 'dry-run-1',
    status: 'failed',
    result_summary: null,
    error_message: null,
    ...overrides,
  }
}

async function dryRunMessage(): Promise<string> {
  try {
    await scansApi.dryRun('demo', DRAFT)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('dryRun resolved, so there is no message to assert on')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('scansApi.dryRun — what the user is told when the check does not answer', () => {
  it('never names the pipeline\'s own word for this at the user', async () => {
    // "Dry run" appears nowhere on the preview panel: the button says Check, the
    // wait says "Working out what this scan would create…", the answer says
    // "Would create N events". These two strings were the only place the
    // mechanism's name reached a screen (tripl-3y7z.6).
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(dryRunJob({})))

    const message = await dryRunMessage()
    expect(message).not.toMatch(/dry.?run/i)
    // ...and it does not restate the heading it renders under, which already
    // says "Could not work out what this scan would create".
    expect(message).not.toContain('work out what this scan would create')
    expect(message).toBe('The check stopped without saying why.')
  })

  it('prefers the reason the run itself gave, when it gave one', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(dryRunJob({ error_message: 'Base query failed: table not found' })),
    )

    expect(await dryRunMessage()).toBe('Base query failed: table not found')
  })

  it('says the wait ran out in the panel\'s own words', async () => {
    // The deadline is checked before the first sleep, so a clock that has
    // already passed it exercises the timeout without waiting five minutes.
    const start = Date.now()
    vi.spyOn(Date, 'now').mockReturnValueOnce(start).mockReturnValue(start + 3_600_000)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(dryRunJob({ status: 'running' })))

    const message = await dryRunMessage()
    expect(message).not.toMatch(/dry.?run/i)
    expect(message).toBe('Timed out working out what this scan would create.')
  })
})
