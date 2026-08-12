import { describe, expect, it } from 'vitest'

import { VIEWER_READ_ONLY_NOTICE, canWrite } from './permissions'

describe('canWrite', () => {
  it('lets an owner and an editor write', () => {
    expect(canWrite('owner')).toBe(true)
    expect(canWrite('editor')).toBe(true)
  })

  it('stops exactly the role the API stops', () => {
    // deps.py `require_editor` rejects "viewer" and nothing else, and this is
    // the whole reason the alerting page needed gating: every Ack, Mute, delete
    // and retry on it answered 403 for this one role (tripl-oxkt.9).
    expect(canWrite('viewer')).toBe(false)
  })

  it('does not read a missing role as a viewer', () => {
    // No session yet, or a component mounted outside the auth provider. Absence
    // of evidence is not evidence of a viewer, and guessing wrong here hides
    // working controls from an editor — the failure the user cannot get past.
    expect(canWrite(null)).toBe(true)
    expect(canWrite(undefined)).toBe(true)
  })
})

describe('VIEWER_READ_ONLY_NOTICE', () => {
  it('names the role and all three things the page can no longer do', () => {
    // One sentence, rendered once per section: the page carries ~80 write
    // affordances and explaining each of them individually is a page that
    // repeats itself eighty times.
    expect(VIEWER_READ_ONLY_NOTICE).toMatch(/viewer role/)
    expect(VIEWER_READ_ONLY_NOTICE).toMatch(/incidents/)
    expect(VIEWER_READ_ONLY_NOTICE).toMatch(/destinations and rules/)
    expect(VIEWER_READ_ONLY_NOTICE).toMatch(/retrying deliveries/)
  })
})
