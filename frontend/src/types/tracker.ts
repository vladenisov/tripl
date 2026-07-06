/**
 * Per-project implementation tracker (Jira) connection config.
 *
 * The raw API token is NEVER returned by the API — `api_token_set` is the only
 * signal that one is stored. `id`/timestamps are null while the project rides
 * the defaults (the row materializes on the first PATCH).
 */
export interface ProjectTrackerConfig {
  id: string | null
  project_id: string
  enabled: boolean
  tracker_type: string
  base_url: string
  project_key: string
  auth_email: string
  issue_type: string
  api_token_set: boolean
  created_at: string | null
  updated_at: string | null
}

/**
 * Partial update for the tracker config (owner-only on the backend). Every
 * field is optional. `api_token` is the RAW token — only send it when the user
 * actually typed one; the backend rejects an empty string and cannot clear a
 * stored token via PATCH, so omit it to preserve the existing token.
 */
export interface ProjectTrackerConfigUpdate {
  enabled?: boolean
  tracker_type?: string
  base_url?: string
  project_key?: string
  auth_email?: string
  api_token?: string
  issue_type?: string
}
