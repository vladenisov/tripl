import { api } from './client'
import type { AuthUser } from '@/types'

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
}
