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

export const authApi = {
  me: () => api.get<AuthUser>('/auth/me'),
  // Unauthenticated bootstrap check: tells the auth screen whether this instance
  // already has users, so the "first account becomes owner" note only shows on a
  // brand-new instance.
  status: () => api.get<{ has_users: boolean }>('/auth/status'),
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
