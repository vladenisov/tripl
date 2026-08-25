import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ServiceSettings } from '@/types'
import { AiSection } from './AiSection'
import {
  COMPARE_FIELDS,
  EMPTY_SECRET_DRAFTS,
  buildUpdate,
  editableFromSettings,
} from './serviceSettingsHelpers'

const AI: ServiceSettings['ai'] = {
  ai_enabled: false,
  ai_base_url: 'https://api.openai.com/v1',
  ai_model: 'gpt-4o-mini',
  ai_api_key_configured: false,
  ai_timeout_seconds: 30,
  ai_max_output_tokens: 700,
  describe_system_prompt: 'describe',
  ask_system_prompt: 'ask',
  alert_explanation_system_prompt: 'explain',
  search_embeddings_enabled: true,
  search_embedding_provider: 'openai',
  search_embedding_model: 'text-embedding-3-small',
  search_embedding_api_key_configured: false,
  search_embedding_dimensions: 1536,
  search_embedding_base_url: 'https://api.openai.com/v1',
}

function settingsFixture(
  ai: Partial<ServiceSettings['ai']> = {},
  sources: ServiceSettings['sources'] = {},
): ServiceSettings {
  return {
    runtime: { app_base_url: '', scan_row_limit_default: 100, metrics_row_limit_default: 100 },
    security: {
      registration_mode: 'open',
      cors_allow_origins: '',
      session_cookie_name: 'tripl_session',
      session_ttl_hours: 168,
      session_cookie_secure: false,
      security_headers_enabled: true,
      hsts_enabled: false,
      hsts_max_age_seconds: 31536000,
      content_security_policy: '',
      rate_limit_enabled: true,
      rate_limit_login_per_minute: 5,
      rate_limit_register_per_hour: 3,
      rate_limit_trust_forwarded_for: false,
    },
    storage: {
      photo_storage_backend: 'local',
      photo_local_dir: './var/photos',
      photo_max_size_mb: 10,
      photo_allowed_mime: 'image/png',
      gcs_photo_bucket: '',
      gcs_photo_credentials_path: '',
      gcs_photo_public: false,
      gcs_photo_signed_url_ttl_seconds: 3600,
    },
    observability: {
      request_id_header: 'X-Request-ID',
      log_level: 'INFO',
      log_json: false,
      prometheus_metrics_enabled: false,
      otel_exporter_otlp_endpoint: '',
      otel_service_name: 'tripl',
    },
    email: {
      smtp_host: '',
      smtp_port: 587,
      smtp_username: '',
      smtp_password_configured: false,
      smtp_use_tls: true,
      smtp_from_address: '',
    },
    ai: { ...AI, ...ai },
    system: {
      debug: false,
      database_url_configured: true,
      sync_database_url_configured: true,
      rabbitmq_url_configured: true,
      redis_url_configured: false,
      encryption_key_configured: true,
      openai_api_key_configured: false,
      alembic_revision: 'abc123def456',
      alembic_head_revision: 'abc123def456',
      alembic_up_to_date: true,
    },
    overridden_fields: [],
    sources,
  } as ServiceSettings
}

function renderSection(settings: ServiceSettings) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AiSection
        form={editableFromSettings(settings)}
        settings={settings}
        secretDrafts={EMPTY_SECRET_DRAFTS}
        setField={vi.fn()}
        setSecretDrafts={vi.fn()}
        saving={false}
        onClearSecret={vi.fn()}
      />
    </QueryClientProvider>,
  )
}

/**
 * The label + badge cluster of one row, so each row's badge can be read on its
 * own — every other field in the section carries a badge too.
 */
function labelRow(label: string): HTMLElement {
  const parent = screen.getByText(label).parentElement
  if (!parent) throw new Error(`no label row around "${label}"`)
  return parent
}

/**
 * SEARCH_EMBEDDING_BASE_URL decides where every indexed event name, description
 * and field value is POSTed, and it has been dropped from the compose env
 * allowlist three times. Nothing in the running system reported it, so the only
 * way to notice was to read the source and diff values by hand (tripl-wkwv.2).
 */
describe('Instance AI — the embeddings endpoint', () => {
  it('shows the endpoint the indexed plan text is actually sent to', () => {
    renderSection(settingsFixture({ search_embedding_base_url: 'https://llm.internal/v1' }))

    expect(screen.getByLabelText('Embeddings base URL')).toHaveValue('https://llm.internal/v1')
  })

  it('never lets it be edited, because repointing it poisons the existing index', () => {
    renderSection(settingsFixture())

    expect(screen.getByLabelText('Embeddings base URL')).toBeDisabled()
  })

  it('says which variable sets it and what changing it really costs', () => {
    renderSection(settingsFixture())

    const hint = screen.getByText(/SEARCH_EMBEDDING_BASE_URL/)
    expect(hint).toHaveTextContent(/POSTed here/i)
    expect(hint).toHaveTextContent(/re-embed and a deploy, not a setting/i)
  })

  it('badges the built-in default as Default rather than asserting an env variable', () => {
    // The prod state the issue documents: the value is bit-identical to the
    // shipped default and nothing was ever delivered for it.
    renderSection(settingsFixture({}, { 'ai.search_embedding_base_url': 'default' }))

    expect(within(labelRow('Embeddings base URL')).getByText('Default')).toBeInTheDocument()
  })

  it('badges a delivered endpoint as Env, which is the evidence the issue asked for', () => {
    renderSection(
      settingsFixture(
        { search_embedding_base_url: 'https://llm.internal/v1' },
        { 'ai.search_embedding_base_url': 'env' },
      ),
    )

    expect(within(labelRow('Embeddings base URL')).getByText('Env')).toBeInTheDocument()
  })

  it('badges the other read-only embedding field the same way', () => {
    // Endpoint and width are the two facts that describe the vector space every
    // stored embedding was written into; a badge on one and not the other would
    // read as an oversight.
    renderSection(settingsFixture({}, { 'ai.search_embedding_dimensions': 'env' }))

    expect(within(labelRow('Embedding dimensions')).getByText('Env')).toBeInTheDocument()
  })

  it('keeps the endpoint out of the update payload entirely', () => {
    // The frontend gate: absent from COMPARE_FIELDS, so buildSectionDiff can
    // never put it in a PATCH even if something wrote it into the form. The
    // backend gates on AiSettingsUpdate and EDITABLE_FIELDS independently.
    const saved = settingsFixture()
    const base = editableFromSettings(saved)
    const form = {
      ...base,
      ai: { ...base.ai, search_embedding_base_url: 'https://evil.example/v1', ai_model: 'gpt-5' },
    }

    const update = buildUpdate(form, saved, EMPTY_SECRET_DRAFTS)

    expect(update.ai).toEqual({ ai_model: 'gpt-5' })
    expect(COMPARE_FIELDS.ai).not.toContain('search_embedding_base_url')
  })
})

/**
 * The reset card counts a stored key as an override — it is one, and Reset nulls
 * it — while the row itself rendered no badge at all. So an instance whose only
 * override was an API key showed a red "Clears the 1 AI override on this
 * instance — every field badged Override above" beside rows that all read
 * "Default": the same copy-versus-badge disagreement tripl-5qp9 was about, in a
 * section that now has three badge states (tripl-wkwv.2). overrideCount's field
 * set and the badged field set have to be one set.
 */
describe('Instance AI — the stored keys', () => {
  it('badges the keys the reset card already counts as overrides', () => {
    renderSection(
      settingsFixture({}, { 'ai.ai_api_key': 'override', 'ai.search_embedding_api_key': 'env' }),
    )

    expect(within(labelRow('AI API key')).getByText('Override')).toBeInTheDocument()
    expect(within(labelRow('Embedding API key')).getByText('Env')).toBeInTheDocument()
  })
})
