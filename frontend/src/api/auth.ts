import { api } from './client'
import type { AuthUser } from '@/types'

/** Neutral response to a password-reset request. `email_configured` is an
 *  instance-wide flag (never per-account), so the UI can show the right copy
 *  without leaking whether the submitted address is registered. */
export interface PasswordResetRequestResponse {
  message: string
  email_configured: boolean
}

export interface PasswordResetConfirmResponse {
  message: string
}

/** Unauthenticated instance probe for the auth screen. Both flags are
 *  instance-wide (never per-account): `has_users` gates the "first account
 *  becomes owner" note, `registration_enabled` says whether POST /auth/register
 *  would be accepted right now, so a closed instance can hide the sign-up form
 *  instead of letting a visitor discover the policy from a 403. */
export interface AuthStatusResponse {
  has_users: boolean
  registration_enabled: boolean
}

export const authApi = {
  me: () => api.get<AuthUser>('/auth/me'),
  status: () => api.get<AuthStatusResponse>('/auth/status'),
  login: (data: { email: string; password: string }) =>
    api.post<AuthUser>('/auth/login', data),
  register: (data: { email: string; password: string; name?: string }) =>
    api.post<AuthUser>('/auth/register', data),
  logout: () => api.post<void>('/auth/logout'),
  // Self-service password reset. `request` always resolves 200 with a neutral
  // message (no user enumeration); `confirm` redeems the emailed token.
  requestPasswordReset: (data: { email: string }) =>
    api.post<PasswordResetRequestResponse>('/auth/password-reset/request', data),
  confirmPasswordReset: (data: { token: string; new_password: string }) =>
    api.post<PasswordResetConfirmResponse>('/auth/password-reset/confirm', data),
}
