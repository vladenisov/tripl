import { describe, expect, it } from 'vitest'
import {
  EMAIL_DOMAIN_UNUSABLE_MESSAGE,
  EMAIL_INVALID_MESSAGE,
  humanizeValidationMessage,
} from './validationMessage'

// Verbatim 422 entries as pydantic 2.13 / email-validator 2.3 emit them for
// POST /auth/register — reproduced against the real RegisterRequest schema.
const RESERVED_DOMAIN_ENTRY = {
  type: 'value_error',
  loc: ['body', 'email'],
  msg:
    'value is not a valid email address: The part after the @-sign is a special-use ' +
    'or reserved name that cannot be used with email.',
} as const
const MISSING_AT_SIGN_ENTRY = {
  type: 'value_error',
  loc: ['body', 'email'],
  msg: 'value is not a valid email address: An email address must have an @-sign.',
} as const
const NO_PERIOD_ENTRY = {
  type: 'value_error',
  loc: ['body', 'email'],
  msg:
    'value is not a valid email address: The part after the @-sign is not valid. ' +
    'It should have a period.',
} as const
const PASSWORD_POLICY_ENTRY = {
  type: 'value_error',
  loc: ['body', 'password'],
  msg: 'Value error, Password must be at least 12 characters and include a number and a symbol.',
} as const

/** No user-facing message may carry email-validator's own phrasing. */
function expectNoLibraryPhrasing(message: string) {
  expect(message).not.toContain('special-use')
  expect(message).not.toContain('@-sign')
  expect(message).not.toContain('value is not a valid')
}

describe('humanizeValidationMessage', () => {
  it('rewrites the reserved-domain email reason to the domain-unusable copy', () => {
    // Arrange / Act
    const message = humanizeValidationMessage(RESERVED_DOMAIN_ENTRY)

    // Assert
    expect(message).toBe(EMAIL_DOMAIN_UNUSABLE_MESSAGE)
    expectNoLibraryPhrasing(message)
  })

  it('rewrites a missing @-sign to the generic invalid-email copy', () => {
    expect(humanizeValidationMessage(MISSING_AT_SIGN_ENTRY)).toBe(EMAIL_INVALID_MESSAGE)
  })

  it('rewrites an unparseable domain to the generic invalid-email copy', () => {
    expect(humanizeValidationMessage(NO_PERIOD_ENTRY)).toBe(EMAIL_INVALID_MESSAGE)
  })

  it('falls back to the invalid-email copy for an unrecognised email wording', () => {
    // The wrapper prefix is gone, so only the field-name belt can catch this —
    // it still must not reach the user verbatim.
    const message = humanizeValidationMessage({
      type: 'value_error',
      loc: ['body', 'email'],
      msg: 'some future library wording',
    })

    expect(message).toBe(EMAIL_INVALID_MESSAGE)
  })

  it("strips pydantic's wrapper from the project's own password-policy copy", () => {
    expect(humanizeValidationMessage(PASSWORD_POLICY_ENTRY)).toBe(
      'Password must be at least 12 characters and include a number and a symbol.',
    )
  })

  it('keeps the detail of a missing-field error', () => {
    expect(
      humanizeValidationMessage({ type: 'missing', loc: ['body', 'name'], msg: 'Field required' }),
    ).toBe('Field required')
  })

  it('keeps the detail of a length-constraint error', () => {
    expect(
      humanizeValidationMessage({
        type: 'string_too_long',
        loc: ['body', 'name'],
        msg: 'String should have at most 255 characters',
      }),
    ).toBe('String should have at most 255 characters')
  })

  it('keeps the detail of a non-email value_error whose field name contains "email"', () => {
    // Proves the email rule keys on the field/wrapper, not on the substring.
    expect(
      humanizeValidationMessage({
        type: 'value_error',
        loc: ['body', 'email_recipients'],
        msg: 'Value error, Email recipients list cannot exceed 50 entries',
      }),
    ).toBe('Email recipients list cannot exceed 50 entries')
  })
})
