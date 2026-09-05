import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CADENCE,
  cadenceToCron,
  cronToCadence,
  describeCron,
  validateCadence,
  type CadenceDraft,
} from './deliverySchedule'

const draft = (over: Partial<CadenceDraft>): CadenceDraft => ({ ...DEFAULT_CADENCE, ...over })

describe('cadenceToCron', () => {
  it('means "immediate" with a null expression, which is the wire default', () => {
    expect(cadenceToCron(draft({ mode: 'immediate' }))).toBeNull()
  })

  it('builds the expression each preset promises', () => {
    expect(cadenceToCron(draft({ mode: 'hourly' }))).toBe('0 * * * *')
    expect(cadenceToCron(draft({ mode: 'daily', time: '09:00' }))).toBe('0 9 * * *')
    expect(cadenceToCron(draft({ mode: 'daily', time: '18:30' }))).toBe('30 18 * * *')
    expect(cadenceToCron(draft({ mode: 'weekly', time: '07:15', weekday: 1 }))).toBe('15 7 * * 1')
    expect(cadenceToCron(draft({ mode: 'times_of_day', times: '09:00, 18:00' }))).toBe(
      '0 9,18 * * *',
    )
  })

  it('passes a custom expression through untouched apart from whitespace', () => {
    expect(cadenceToCron(draft({ mode: 'custom', cron: '  */5   *  * * 1-5 ' }))).toBe(
      '*/5 * * * 1-5',
    )
  })
})

describe('cronToCadence', () => {
  it('round-trips every preset', () => {
    for (const value of [
      draft({ mode: 'hourly' }),
      draft({ mode: 'daily', time: '09:00' }),
      draft({ mode: 'daily', time: '18:30' }),
      draft({ mode: 'weekly', time: '07:15', weekday: 3 }),
      draft({ mode: 'times_of_day', times: '09:00, 18:00' }),
    ]) {
      const cron = cadenceToCron(value)
      const back = cronToCadence(cron)
      expect(cadenceToCron(back)).toBe(cron)
      expect(back.mode).toBe(value.mode)
    }
  })

  it('reads an empty or missing expression as immediate', () => {
    expect(cronToCadence(null).mode).toBe('immediate')
    expect(cronToCadence(undefined).mode).toBe('immediate')
    expect(cronToCadence('   ').mode).toBe('immediate')
  })

  it('keeps an expression the presets cannot express in custom mode, verbatim', () => {
    // A hand-written cron must never be silently rewritten into a preset that
    // means something slightly different.
    const exotic = '*/5 9-17 * * 1-5'
    const back = cronToCadence(exotic)
    expect(back.mode).toBe('custom')
    expect(cadenceToCron(back)).toBe(exotic)
  })

  it('treats Sunday written as 7 the way cron does', () => {
    expect(cronToCadence('0 9 * * 7').weekday).toBe(0)
  })
})

describe('describeCron', () => {
  it('says plainly what happens, including the unchanged default', () => {
    expect(describeCron(null)).toBe('Immediately, after every collection')
    expect(describeCron('0 9 * * *')).toBe('Daily at 09:00')
    expect(describeCron('0 * * * *')).toBe('Hourly, on the hour')
    expect(describeCron('0 9,18 * * *')).toBe('Every day at 09:00, 18:00')
    expect(describeCron('15 7 * * 1')).toBe('Every Monday at 07:15')
    expect(describeCron('*/5 9-17 * * 1-5')).toContain('Custom')
  })
})

describe('validateCadence', () => {
  it('accepts what the presets produce', () => {
    expect(validateCadence(draft({ mode: 'immediate' }))).toBeNull()
    expect(validateCadence(draft({ mode: 'daily', time: '09:00' }))).toBeNull()
    expect(validateCadence(draft({ mode: 'times_of_day', times: '09:00, 18:00' }))).toBeNull()
    expect(validateCadence(draft({ mode: 'custom', cron: '0 9 * * *' }))).toBeNull()
  })

  it('catches the common typos before a round trip', () => {
    expect(validateCadence(draft({ mode: 'daily', time: '9am' }))).toContain('HH:MM')
    expect(validateCadence(draft({ mode: 'daily', time: '25:00' }))).toContain('HH:MM')
    expect(validateCadence(draft({ mode: 'times_of_day', times: '' }))).toContain('at least one')
    expect(validateCadence(draft({ mode: 'custom', cron: '@daily' }))).toContain('5 fields')
    expect(validateCadence(draft({ mode: 'custom', cron: '' }))).toContain('cron expression')
  })
})
