/**
 * FastAPI 422 `detail` humaniser.
 *
 * Library phrasing must never surface verbatim in the UI: pydantic wraps an
 * `email_validator` failure as `value is not a valid email address: The part
 * after the @-sign is a special-use or reserved name that cannot be used with
 * email.`, and it prefixes every `ValueError` a `field_validator` raises with
 * `Value error, ` — which lands on top of copy this codebase authored itself
 * (`PASSWORD_POLICY_MESSAGE`, the `alerting_validation` messages).
 * `humanizeValidationMessage` rewrites those two cases and leaves every other
 * entry untouched, so `Field required` / `String should have at most 255
 * characters` keep their detail.
 *
 * Applied in `formatValidationDetail` (frontend/src/api/client.ts), the single
 * place a 422 becomes user-visible text, so every form gets it: register and
 * password-reset (AuthPage), member invite (UsersPage), and every surface that
 * renders `ApiError.message` via `getErrorMessage`. The raw entries stay on
 * `ApiError.fields`.
 *
 * Detection strings verified against pydantic 2.13 / email-validator 2.3.
 */

/** Structural shape of one FastAPI 422 `detail` entry (`ApiFieldError` fits). */
export interface ValidationDetailEntry {
  loc: readonly (string | number)[]
  msg: string
  type?: string
}

export const EMAIL_INVALID_MESSAGE = 'Enter a valid email address.'
export const EMAIL_DOMAIN_UNUSABLE_MESSAGE =
  'That email domain cannot be used. Enter an address on a real, deliverable domain.'

/** Pydantic's `EmailStr` wrapper around every `email_validator` reason. */
const EMAIL_VALIDATOR_PREFIX = 'value is not a valid email address'
/** The one reason worth its own copy: the domain is syntactically fine but unusable. */
const RESERVED_DOMAIN_MARKER = 'special-use or reserved'
/** Pydantic's noise in front of a message a `field_validator` raised itself. */
const PYDANTIC_WRAPPER_PREFIXES = ['Value error, ', 'Assertion failed, '] as const

/** Uncover the authored message by dropping pydantic's wrapper prefix, if any. */
function stripPydanticWrapper(msg: string): string {
  const prefix = PYDANTIC_WRAPPER_PREFIXES.find((candidate) => msg.startsWith(candidate))
  return prefix ? msg.slice(prefix.length) : msg
}

function isEmailFieldError(entry: ValidationDetailEntry): boolean {
  if (entry.msg.toLowerCase().startsWith(EMAIL_VALIDATOR_PREFIX)) return true
  // Belt: if email-validator/pydantic ever rewords the wrapper, a value_error
  // on a field literally named `email` still must not reach the user verbatim.
  return entry.type === 'value_error' && entry.loc[entry.loc.length - 1] === 'email'
}

/**
 * Rewrite one 422 entry into text worth showing a user.
 *
 * Only the email case is collapsed to fixed copy — the field has one possible
 * remedy, so the library's reason adds nothing actionable. The branch is chosen
 * by the stable wrapper prefix (or the field name), and only the *variant* by
 * the reason marker, so an unrecognised reason still falls to
 * `EMAIL_INVALID_MESSAGE` rather than leaking.
 */
export function humanizeValidationMessage(entry: ValidationDetailEntry): string {
  if (isEmailFieldError(entry)) {
    return entry.msg.toLowerCase().includes(RESERVED_DOMAIN_MARKER)
      ? EMAIL_DOMAIN_UNUSABLE_MESSAGE
      : EMAIL_INVALID_MESSAGE
  }
  return stripPydanticWrapper(entry.msg)
}
