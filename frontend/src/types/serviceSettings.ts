export type SettingSource = 'env' | 'override'

export interface RuntimeSettings {
  app_base_url: string
  scan_row_limit_default: number
  metrics_row_limit_default: number
}

export interface SecuritySettings {
  cors_allow_origins: string
  session_cookie_name: string
  session_ttl_hours: number
  session_cookie_secure: boolean
  security_headers_enabled: boolean
  hsts_enabled: boolean
  hsts_max_age_seconds: number
  content_security_policy: string
  rate_limit_enabled: boolean
  rate_limit_login_per_minute: number
  rate_limit_register_per_hour: number
  rate_limit_trust_forwarded_for: boolean
}

export interface StorageSettings {
  photo_storage_backend: string
  photo_local_dir: string
  photo_max_size_mb: number
  photo_allowed_mime: string
  gcs_photo_bucket: string
  gcs_photo_credentials_path: string
  gcs_photo_public: boolean
  gcs_photo_signed_url_ttl_seconds: number
}

export interface ObservabilitySettings {
  request_id_header: string
  log_level: string
  log_json: boolean
  prometheus_metrics_enabled: boolean
  otel_exporter_otlp_endpoint: string
  otel_service_name: string
}

export interface EmailSettings {
  smtp_host: string
  smtp_port: number
  smtp_username: string
  smtp_password_configured: boolean
  smtp_use_tls: boolean
  smtp_from_address: string
}

export interface AiServiceSettings {
  ai_enabled: boolean
  ai_base_url: string
  ai_model: string
  ai_api_key_configured: boolean
  ai_timeout_seconds: number
  ai_max_output_tokens: number
  describe_system_prompt: string
  ask_system_prompt: string
  alert_explanation_system_prompt: string
  search_embeddings_enabled: boolean
  search_embedding_provider: string
  search_embedding_model: string
  search_embedding_api_key_configured: boolean
  search_embedding_dimensions: number
}

export interface SystemSettings {
  debug: boolean
  database_url_configured: boolean
  sync_database_url_configured: boolean
  rabbitmq_url_configured: boolean
  redis_url_configured: boolean
  encryption_key_configured: boolean
  openai_api_key_configured: boolean
}

export interface ServiceSettings {
  runtime: RuntimeSettings
  security: SecuritySettings
  storage: StorageSettings
  observability: ObservabilitySettings
  email: EmailSettings
  ai: AiServiceSettings
  system: SystemSettings
  overridden_fields: string[]
  sources: Record<string, SettingSource>
}

export type RuntimeSettingsUpdate = Partial<{
  [K in keyof RuntimeSettings]: RuntimeSettings[K] | null
}>

export type SecuritySettingsUpdate = Partial<{
  [K in keyof SecuritySettings]: SecuritySettings[K] | null
}>

export type StorageSettingsUpdate = Partial<{
  [K in keyof StorageSettings]: StorageSettings[K] | null
}>

export type ObservabilitySettingsUpdate = Partial<{
  [K in keyof ObservabilitySettings]: ObservabilitySettings[K] | null
}>

export type EmailSettingsUpdate = Partial<{
  smtp_host: string | null
  smtp_port: number | null
  smtp_username: string | null
  smtp_password: string | null
  smtp_use_tls: boolean | null
  smtp_from_address: string | null
}>

export type AiSettingsUpdate = Partial<{
  ai_enabled: boolean | null
  ai_base_url: string | null
  ai_model: string | null
  ai_api_key: string | null
  ai_timeout_seconds: number | null
  ai_max_output_tokens: number | null
  describe_system_prompt: string | null
  ask_system_prompt: string | null
  alert_explanation_system_prompt: string | null
  search_embeddings_enabled: boolean | null
  search_embedding_provider: string | null
  search_embedding_model: string | null
  search_embedding_api_key: string | null
}>

export interface ServiceSettingsUpdate {
  runtime?: RuntimeSettingsUpdate
  security?: SecuritySettingsUpdate
  storage?: StorageSettingsUpdate
  observability?: ObservabilitySettingsUpdate
  email?: EmailSettingsUpdate
  ai?: AiSettingsUpdate
}

export interface AiSettingsResponse {
  ai: AiServiceSettings
  overridden_fields: string[]
  sources: Record<string, SettingSource>
}

export interface SettingsTestResponse {
  ok: boolean
  message: string
}
