export type Role = 'owner' | 'editor' | 'viewer'

export const ROLE_OPTIONS: { value: Role; label: string; chip: string }[] = [
  { value: 'owner', label: 'Owner', chip: 'bg-violet-500/15 text-violet-700' },
  { value: 'editor', label: 'Editor', chip: 'bg-sky-500/15 text-sky-700' },
  { value: 'viewer', label: 'Viewer', chip: 'bg-muted text-muted-foreground' },
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
