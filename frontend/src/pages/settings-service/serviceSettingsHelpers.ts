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
