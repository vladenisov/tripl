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

/**
 * One tracker ticket opened when a plan branch merged, as returned by
 * `GET /projects/{slug}/branches/{branch_id}/implementation-tickets`.
 *
 * Written only by the backend (merge worker + poll sync), so every field here
 * is read-only. `status` is `open` until the tracker reports the issue done, at
 * which point sync flips it to `closed` and stamps `closed_at`; it is a plain
 * string because the backend column is one too. `external_url` is `''` when the
 * tracker answered without an issue key — render the key as text, not a link.
 */
export interface ImplementationTicket {
  id: string
  project_id: string
  branch_id: string
  tracker_type: string
  external_id: string | null
  external_key: string | null
  external_url: string
  status: string
  summary: string
  /** Main-branch event ids the ticket covers; they advance to `implemented`
   * when the ticket closes. */
  event_ids: string[]
  created_at: string
  updated_at: string
  closed_at: string | null
}
