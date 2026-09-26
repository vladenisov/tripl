import { describe, expect, it } from 'vitest'
import { breaksNameConvention, inferNameConvention, nameStyle } from './eventNameConvention'

describe('nameStyle', () => {
  it.each([
    ['Home Screen View', 'spaced'],
    ['checkout:completed', 'colon'],
    ['screen_view_home', 'snake'],
    ['sign-up', 'kebab'],
    ['app.opened', 'dot'],
    ['signUp', 'camel'],
    ['SignUp', 'pascal'],
    ['/buoy/2758a8b1', 'path'],
    ['purchase', 'word'],
  ])('reads %s as %s', (name, style) => {
    expect(nameStyle(name)).toBe(style)
  })

  it('has no style for a name that mixes them', () => {
    expect(nameStyle('Screen_view-home')).toBeNull()
  })
})

describe('inferNameConvention', () => {
  it("takes the style most of the type's names share, with one of them as the example", () => {
    expect(
      inferNameConvention(['Home Screen View', 'Settings Screen View', 'Spot Screen View', 'spot_view']),
    ).toBeNull() // 3 of 4 is not enough agreement
    expect(
      inferNameConvention([
        'Home Screen View',
        'Settings Screen View',
        'Spot Screen View',
        'Map Screen View',
        'spot_view',
      ]),
    ).toEqual({ style: 'spaced', example: 'Home Screen View' })
  })

  it('counts a lone word towards snake case, and prefers a multi-part example', () => {
    expect(inferNameConvention(['purchase', 'sign_up', 'sign_out'])).toEqual({
      style: 'snake',
      example: 'sign_up',
    })
  })

  it('claims nothing from too few names', () => {
    expect(inferNameConvention(['sign_up', 'sign_out'])).toBeNull()
    expect(inferNameConvention([])).toBeNull()
  })
})

describe('breaksNameConvention', () => {
  const snake = { style: 'snake', example: 'sign_up' } as const
  const spaced = { style: 'spaced', example: 'Home Screen View' } as const

  it('points out a name in another style', () => {
    expect(breaksNameConvention('checkout:completed', snake)).toBe(true)
    expect(breaksNameConvention('home_screen', spaced)).toBe(true)
  })

  it('accepts a name in the same style, and one-part names that fit it', () => {
    expect(breaksNameConvention('sign_in', snake)).toBe(false)
    expect(breaksNameConvention('purchase', snake)).toBe(false)
    expect(breaksNameConvention('Profile Screen View', spaced)).toBe(false)
    expect(breaksNameConvention('Profile', spaced)).toBe(false)
  })

  it('says nothing without a convention or a name', () => {
    expect(breaksNameConvention('anything', null)).toBe(false)
    expect(breaksNameConvention('  ', snake)).toBe(false)
  })
})
