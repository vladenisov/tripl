export type Role = 'owner' | 'editor' | 'viewer'

// A role's pill tone lives in components/settings/role-chip.tsx (ST-16); this
// list is the order and the words.
export const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
]

export interface AuthUser {
  id: string
  email: string
  name: string | null
  role: Role
  created_at: string
  updated_at: string
}

export interface UserListItem {
  id: string
  email: string
  name: string | null
  role: Role
  created_at: string
}

export type ApiKeyScope = 'read' | 'write'

export interface ApiKey {
  id: string
  name: string
  key_prefix: string
  scope: ApiKeyScope
  project_id: string | null
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

export interface ApiKeyWithToken extends ApiKey {
  token: string
}
