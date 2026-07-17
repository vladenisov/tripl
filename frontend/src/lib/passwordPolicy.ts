/**
 * Client-side source of truth for the password policy, kept in lockstep with the
 * backend enforcement in `tripl/schemas/auth.py` (>= 12 characters, at least one
 * number and one symbol). Both the register form (AuthPage) and the change-password
 * hint (Security settings) render `PASSWORD_POLICY_HINT`, so the advertised policy
 * can never drift from what the server actually accepts.
 *
 * Client validation is a UX affordance only — the schema validator is the real
 * security boundary.
 */
export const PASSWORD_MIN_LENGTH = 12

export const PASSWORD_POLICY_HINT = 'At least 12 characters, with a number and symbol.'
