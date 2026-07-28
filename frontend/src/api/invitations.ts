import { api } from './client'
import type { Role } from '../types'

/** A pending invitation as listed on Members. Never carries a redeemable token. */
export interface Invitation {
  id: string
  email: string
  role: Role
  invited_by_user_id: string | null
  expires_at: string
  created_at: string
  is_expired: boolean
}

/**
 * The mint response — the only place the redeem link ever appears.
 *
 * `accept_path` is a path rather than an absolute URL because the backend does
 * not reliably know its own public origin (proxy, or an SPA served elsewhere),
 * so the client joins it to `window.location.origin` instead of the server
 * guessing wrong and producing a link that does not work.
 */
export interface InvitationCreated {
  invitation: Invitation
  accept_path: string
  expires_at: string
}

/** What the redeem screen may show before the invitee has an account. */
export interface InvitationPreview {
  email: string
  role: Role
  expires_at: string
}

export const invitationsApi = {
  list: () => api.get<Invitation[]>('/users/invitations'),
  create: (email: string, role: Role) =>
    api.post<InvitationCreated>('/users/invitations', { email, role }),
  revoke: (invitationId: string) => api.del(`/users/invitations/${invitationId}`),

  // Unauthenticated: the invitee has no account yet, which is the point.
  preview: (token: string) => api.get<InvitationPreview>(`/auth/invitations/${token}`),
  accept: (token: string, password: string, name?: string) =>
    api.post(`/auth/invitations/${token}/accept`, { password, name: name || null }),
}
