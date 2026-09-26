import { describe, expect, it } from 'vitest'

import { channelLabel, TICKET_CHANNELS } from './alertChannels'

describe('channelLabel', () => {
  it('names a channel as a reader does, not as the wire spells it', () => {
    expect(channelLabel('slack')).toBe('Slack')
    expect(channelLabel('linear')).toBe('Linear')
    expect(channelLabel('demo_sink')).toBe('Local sink')
  })

  it('reads an unknown channel as itself rather than as nothing', () => {
    expect(channelLabel('pagerduty')).toBe('pagerduty')
  })
})

describe('TICKET_CHANNELS', () => {
  it('holds the channels whose every send opens an issue', () => {
    expect([...TICKET_CHANNELS].sort()).toEqual(['jira', 'linear'])
  })
})
