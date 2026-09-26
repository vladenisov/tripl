import { describe, expect, it } from 'vitest'
import {
  PHONE_HEADER_ROW,
  PHONE_QUIET_CELL,
  PHONE_ROW,
  PHONE_SELECT_ALL_CAPTION,
  PHONE_SELECT_ALL_HEAD,
  PHONE_SELECT_CELL,
} from './eventsPhoneCard'

const classes = (value: string) => value.split(/\s+/).filter(Boolean)

// Every class here is scoped below md: the desktop table must not change.
// These are class-string guards only: jsdom has no layout and Tailwind is not
// loaded, so a utility that never generates still passes. The card layout at
// 375px itself is checked in a browser, not here.
describe('events phone card classes', () => {
  it('scopes the card classes to phones', () => {
    for (const value of [PHONE_ROW, PHONE_HEADER_ROW, PHONE_QUIET_CELL, PHONE_SELECT_CELL, PHONE_SELECT_ALL_HEAD]) {
      for (const cls of classes(value)) expect(cls).toMatch(/^max-md:/)
    }
  })

  it('hides the empty cells of a card (no handle, a viewer\'s checkbox)', () => {
    expect(classes(PHONE_ROW)).toContain('max-md:[&>td:empty]:hidden')
  })

  it('sizes the select cells to their checkbox, header and rows alike', () => {
    expect(classes(PHONE_SELECT_CELL)).toContain('max-md:w-auto')
    expect(classes(PHONE_SELECT_ALL_HEAD)).toEqual(
      expect.arrayContaining(['max-md:w-auto', 'max-md:flex', 'max-md:items-center']),
    )
  })

  it('shows the "Select all" caption on phones only', () => {
    expect(classes(PHONE_SELECT_ALL_CAPTION)).toContain('md:hidden')
  })
})
