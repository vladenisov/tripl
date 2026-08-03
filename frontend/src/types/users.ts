export type Role = 'owner' | 'editor' | 'viewer'

// Role is a category, not a status, so the tones here are read as hues rather
// than as verdicts. Owner takes `warning` because it is the one role that can
// delete a project; editor keeps the blue it always had (`info` is the same
// hue family as the sky shade it replaces); viewer stays neutral.
export const ROLE_OPTIONS: { value: Role; label: string; chip: string }[] = [
  { value: 'owner', label: 'Owner', chip: 'bg-warning-soft text-warning' },
  { value: 'editor', label: 'Editor', chip: 'bg-info-soft text-info' },
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
