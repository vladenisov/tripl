import type {
  AiServiceSettings,
  EmailSettings,
  ObservabilitySettings,
  RuntimeSettings,
  SecuritySettings,
  ServiceSettings,
  ServiceSettingsUpdate,
  StorageSettings,
} from '@/types'

export type SectionKey = 'runtime' | 'ai' | 'email' | 'security' | 'storage' | 'observability'

/** Section names as the rail and the page header spell them. */
export const SECTION_LABELS: Record<SectionKey, string> = {
  runtime: 'Runtime',
  ai: 'AI',
  email: 'Email',
  security: 'Security & access',
  storage: 'Storage',
  observability: 'Observability',
}

/** The three secrets that are stored encrypted and never read back. */
export type SecretField = 'ai_api_key' | 'search_embedding_api_key' | 'smtp_password'

export type EditableSettings = {
  runtime: RuntimeSettings
  ai: AiServiceSettings
  email: EmailSettings
  security: SecuritySettings
  storage: StorageSettings
  observability: ObservabilitySettings
}

export type SecretDrafts = {
  ai_api_key: string
  search_embedding_api_key: string
  smtp_password: string
}

export const EMPTY_SECRET_DRAFTS: SecretDrafts = {
  ai_api_key: '',
  search_embedding_api_key: '',
  smtp_password: '',
}

export const RESET_FIELDS: Record<SectionKey, readonly string[]> = {
  runtime: ['app_base_url', 'scan_row_limit_default', 'metrics_row_limit_default'],
  ai: [
    'ai_enabled',
    'ai_base_url',
    'ai_model',
    'ai_api_key',
    'ai_timeout_seconds',
    'ai_max_output_tokens',
    'describe_system_prompt',
    'ask_system_prompt',
    'alert_explanation_system_prompt',
    'search_embeddings_enabled',
    'search_embedding_provider',
    'search_embedding_model',
    'search_embedding_api_key',
  ],
  email: [
    'smtp_host',
    'smtp_port',
    'smtp_username',
    'smtp_password',
    'smtp_use_tls',
    'smtp_from_address',
  ],
  security: [
    'registration_mode',
    'cors_allow_origins',
    'session_cookie_name',
    'session_ttl_hours',
    'session_cookie_secure',
    'security_headers_enabled',
    'hsts_enabled',
    'hsts_max_age_seconds',
    'content_security_policy',
    'rate_limit_enabled',
    'rate_limit_login_per_minute',
    'rate_limit_register_per_hour',
    'rate_limit_trust_forwarded_for',
  ],
  storage: [
    'photo_storage_backend',
    'photo_local_dir',
    'photo_max_size_mb',
    'photo_allowed_mime',
    'gcs_photo_bucket',
    'gcs_photo_credentials_path',
    'gcs_photo_public',
    'gcs_photo_signed_url_ttl_seconds',
  ],
  observability: [
    'request_id_header',
    'log_level',
    'log_json',
    'prometheus_metrics_enabled',
    'otel_exporter_otlp_endpoint',
    'otel_service_name',
  ],
}

export const COMPARE_FIELDS: Record<SectionKey, readonly string[]> = {
  ...RESET_FIELDS,
  ai: RESET_FIELDS.ai.filter(
    field => field !== 'ai_api_key' && field !== 'search_embedding_api_key',
  ),
  email: RESET_FIELDS.email.filter(field => field !== 'smtp_password'),
}

export function editableFromSettings(settings: ServiceSettings): EditableSettings {
  return {
    runtime: { ...settings.runtime },
    ai: { ...settings.ai },
    email: { ...settings.email },
    security: { ...settings.security },
    storage: { ...settings.storage },
    observability: { ...settings.observability },
  }
}

/**
 * Refresh ONE section from the server's stored settings, leaving every other
 * section's in-progress edits alone.
 *
 * Reset and Clear write straight through and get the whole settings object
 * back; adopting it wholesale replaced a `form` that spans all six sections, so
 * clearing the AI key also discarded an unsaved Storage edit or a rewritten
 * prompt — the very draft the leave-guard warns about (tripl-l8v2).
 */
export function adoptSection(
  form: EditableSettings,
  settings: ServiceSettings,
  section: SectionKey,
): EditableSettings {
  return {
    ...form,
    [section]: { ...settings[section] },
  } as EditableSettings
}

/**
 * Same, but keeping every field the user can edit as it stands on screen.
 *
 * Clearing a stored secret flips server-owned state inside the section it
 * touches (`ai_api_key_configured`), so the response has to be adopted — but
 * the prompt being written in the field below it is the user's, not the
 * server's, and reverting it is the loss the leave-guard warns about.
 */
export function adoptSectionKeepingEdits(
  form: EditableSettings,
  settings: ServiceSettings,
  section: SectionKey,
): EditableSettings {
  const merged = { ...settings[section] } as unknown as Record<string, string | number | boolean>
  const edited = form[section] as unknown as Record<string, string | number | boolean>
  for (const field of COMPARE_FIELDS[section]) {
    merged[field] = edited[field]
  }
  return { ...form, [section]: merged } as EditableSettings
}

/**
 * Blank the secret drafts belonging to `section`, leaving the other sections'
 * alone. A section reset nulls its stored secrets server-side (they are in
 * RESET_FIELDS), so a replacement typed into one of those boxes is part of what
 * the user just asked to clear — while a password typed on Email is not.
 */
export function clearSectionSecrets(drafts: SecretDrafts, section: SectionKey): SecretDrafts {
  const next: SecretDrafts = { ...drafts }
  for (const field of RESET_FIELDS[section]) {
    if (field in next) next[field as SecretField] = ''
  }
  return next
}

export function sourceFor(
  settings: ServiceSettings | undefined,
  section: SectionKey,
  field: string,
) {
  return settings?.sources[`${section}.${field}`] ?? 'env'
}

export function buildSectionDiff(
  section: SectionKey,
  fields: readonly string[],
  current: EditableSettings,
  saved: ServiceSettings,
): Record<string, string | number | boolean> {
  const changes: Record<string, string | number | boolean> = {}
  const currentSection = current[section] as unknown as Record<string, string | number | boolean>
  const savedSection = saved[section] as unknown as Record<string, string | number | boolean>
  for (const field of fields) {
    if (currentSection[field] !== savedSection[field]) {
      changes[field] = currentSection[field]
    }
  }
  return changes
}

export function buildUpdate(
  form: EditableSettings | null,
  saved: ServiceSettings | undefined,
  secretDrafts: SecretDrafts,
): ServiceSettingsUpdate {
  if (!form || !saved) return {}
  const update: ServiceSettingsUpdate = {}

  for (const section of Object.keys(COMPARE_FIELDS) as SectionKey[]) {
    const diff = buildSectionDiff(section, COMPARE_FIELDS[section], form, saved)
    if (Object.keys(diff).length > 0) {
      update[section] = diff as never
    }
  }

  if (secretDrafts.ai_api_key.trim()) {
    update.ai = { ...(update.ai ?? {}), ai_api_key: secretDrafts.ai_api_key.trim() }
  }
  if (secretDrafts.search_embedding_api_key.trim()) {
    update.ai = {
      ...(update.ai ?? {}),
      search_embedding_api_key: secretDrafts.search_embedding_api_key.trim(),
    }
  }
  if (secretDrafts.smtp_password.trim()) {
    update.email = {
      ...(update.email ?? {}),
      smtp_password: secretDrafts.smtp_password,
    }
  }

  return update
}

export function hasUpdate(update: ServiceSettingsUpdate) {
  return Object.values(update).some(section => section && Object.keys(section).length > 0)
}

export function resetPayload(section: SectionKey): ServiceSettingsUpdate {
  return {
    [section]: Object.fromEntries(RESET_FIELDS[section].map(field => [field, null])),
  } as ServiceSettingsUpdate
}

/**
 * When a saved override starts being obeyed, per section. Mirrors
 * STARTUP_APPLIED_FIELDS in backend/src/tripl/services/app_settings_service.py:
 * runtime/email/ai are read through build_*_config at request/task time, while
 * security/storage/observability are read once at startup — with
 * registration_mode the one security field applied live. The UI used to promise
 * the exact opposite (a redeploy note on Runtime, which needs none, and silence
 * on Storage and Observability, which do) — tripl-tezn.
 */
const APPLY_NOTES: Record<SectionKey, string> = {
  runtime: 'Saved overrides apply to the very next request or scan task — no restart needed.',
  email: 'Saved overrides apply to the next message tripl sends — no restart needed.',
  ai: 'Saved overrides apply to the next AI call — no restart needed.',
  security:
    'Saved overrides apply after the next restart of the API, except Self-service registration, which applies to the very next signup attempt.',
  storage:
    'Saved overrides apply after the next restart of the API and workers — until then photos keep landing on the backend that is running now.',
  observability: 'Saved overrides apply after the next restart of the API and workers.',
}

export function applyNote(section: SectionKey): string {
  return `${APPLY_NOTES[section]} Unset fields fall back to environment variables.`
}

/** The highest-consequence fields each section reset nulls, named in the confirm. */
const RESET_STAKES: Record<SectionKey, string> = {
  runtime: 'including the app base URL used in invitation links and the ingest endpoint',
  ai: 'including both stored API keys and all three system prompts',
  email: 'including the stored SMTP password',
  security:
    'including Self-service registration — which applies live, so this can reopen public signup — plus the CORS origins, the CSP and the rate limits',
  storage: 'including the photo storage backend, its GCS bucket and its credentials path',
  observability: 'including the log level and the OTLP endpoint',
}

export type ConfirmCopy = { title: string; message: string; confirmLabel: string }

export function resetConfirm(section: SectionKey, hasSectionDraft = false): ConfirmCopy {
  const label = SECTION_LABELS[section]
  // A reset re-reads this section from the server, so an edit made here and not
  // yet saved goes with it. The dialog enumerates every other consequence; it
  // may not stay silent about the one the user can see on screen.
  const draftStake = hasSectionDraft
    ? ` Changes you made in ${label} but have not saved are dropped as well.`
    : ''
  return {
    title: `Reset ${label} to defaults`,
    message: `Clear all ${RESET_FIELDS[section].length} ${label} overrides on this instance — ${RESET_STAKES[section]} — so every one of them falls back to its environment variable. This is saved immediately and cannot be undone.${draftStake}`,
    confirmLabel: 'Reset section',
  }
}

const SECRET_STAKES: Record<SecretField, { name: string; consequence: string }> = {
  ai_api_key: {
    name: 'AI API key',
    consequence: 'Anomaly explanations, schema suggestions and the assistant start failing at once.',
  },
  search_embedding_api_key: {
    name: 'embedding API key',
    consequence: 'Semantic search stops embedding and answering at once.',
  },
  smtp_password: {
    name: 'SMTP password',
    consequence: 'Invitations, alerts and digests stop being delivered at once.',
  },
}

export function clearSecretConfirm(field: SecretField, hasFieldDraft = false): ConfirmCopy {
  const { name, consequence } = SECRET_STAKES[field]
  const draftStake = hasFieldDraft
    ? ' The replacement you typed into this field and have not saved is cleared too.'
    : ''
  return {
    title: `Delete the stored ${name}`,
    // The field beside this button waits for "Save changes"; the button does
    // not — it writes straight through to the server (tripl-ifiy).
    message: `The stored ${name} is deleted on the server as soon as you confirm — this does not wait for Save changes, and it cannot be undone. ${consequence}${draftStake}`,
    confirmLabel: 'Delete',
  }
}
