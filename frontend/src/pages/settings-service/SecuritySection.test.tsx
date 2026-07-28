import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ServiceSettings } from '@/types'
import { SecuritySection } from './SecuritySection'
import { COMPARE_FIELDS, RESET_FIELDS, editableFromSettings } from './serviceSettingsHelpers'

const SECURITY: ServiceSettings['security'] = {
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
}

function settingsFixture(
  overrides: Partial<ServiceSettings['security']> = {},
  sources: ServiceSettings['sources'] = {},
): ServiceSettings {
  return {
    runtime: { app_base_url: '', scan_row_limit_default: 100, metrics_row_limit_default: 100 },
    security: { ...SECURITY, ...overrides },
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
    ai: {
      ai_enabled: false,
      ai_base_url: '',
      ai_model: '',
      ai_api_key_configured: false,
      ai_timeout_seconds: 30,
      ai_max_output_tokens: 700,
      describe_system_prompt: '',
      ask_system_prompt: '',
      alert_explanation_system_prompt: '',
      search_embeddings_enabled: false,
      search_embedding_provider: 'openai',
      search_embedding_model: '',
      search_embedding_api_key_configured: false,
      search_embedding_dimensions: 1536,
    },
    system: {
      debug: false,
      database_url_configured: true,
      sync_database_url_configured: true,
      rabbitmq_url_configured: true,
      redis_url_configured: false,
      encryption_key_configured: true,
      openai_api_key_configured: false,
    },
    overridden_fields: [],
    sources,
  } as ServiceSettings
}

function renderSection(settings: ServiceSettings, setField = vi.fn()) {
  render(
    <SecuritySection
      form={editableFromSettings(settings)}
      settings={settings}
      setField={setField}
      onReset={vi.fn()}
      resetting={false}
    />,
  )
  return setField
}

describe('Instance Security & access — registration', () => {
  it('exposes registration_mode as an owner control (tripl-jfm3.79)', () => {
    renderSection(settingsFixture())

    const select = screen.getByLabelText('Self-service registration') as HTMLSelectElement
    expect(select.value).toBe('open')
    expect(screen.getByRole('option', { name: /^Open —/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /^Disabled —/ })).toBeInTheDocument()
  })

  it('spells out what "open" exposes rather than just naming the mode', () => {
    renderSection(settingsFixture({ registration_mode: 'open' }))

    const hint = screen.getByText(/anyone who can reach this instance can create an account/i)
    expect(hint).toHaveTextContent(/tracking plan/i)
    expect(hint).toHaveTextContent(/roster/i)
    // A new account joins as EDITOR, so the hint has to name the write
    // capability too — "can read X" alone reads as harmless.
    expect(hint).toHaveTextContent(/edit any shared project/i)
    // ...and must NOT keep claiming connection metadata is exposed: this branch
    // made host/port/username owner-only (tripl-jfm3.19), so the old wording
    // now overstates the blast radius.
    expect(hint).not.toHaveTextContent(/connection metadata/i)
    expect(hint).toHaveTextContent(/owner-only/i)
  })

  it('points a closed instance at invitations rather than at reopening the door', () => {
    // This used to assert the hint said there was NO way to add anyone while
    // disabled. That premise died with tripl-jfm3.82 — an owner can now invite
    // directly — so the hint must send them there instead of telling them to
    // reopen registration, which is the advice that made instances stay open.
    renderSection(settingsFixture({ registration_mode: 'disabled' }))

    const hint = screen.getByText(/POST \/auth\/register is refused/i)
    expect(hint).toHaveTextContent(/invite a member/i)
    expect(hint).not.toHaveTextContent(/nobody new can be added/i)
    // The first-owner bootstrap exemption is still worth stating.
    expect(hint).toHaveTextContent(/first account on an instance with no users/i)
  })

  it('reports whether the mode comes from an override or the environment', () => {
    renderSection(settingsFixture({}, { 'security.registration_mode': 'override' }))

    expect(screen.getAllByText('Override')).toHaveLength(1)
  })

  it('routes a change through setField so it lands in the PATCH payload', () => {
    const setField = renderSection(settingsFixture())

    fireEvent.change(screen.getByLabelText('Self-service registration'), {
      target: { value: 'disabled' },
    })

    expect(setField).toHaveBeenCalledWith('security', 'registration_mode', 'disabled')
  })

  it('includes registration_mode in the security diff and reset field lists', () => {
    // Without this the control renders but never reaches PATCH /api/v1/settings.
    expect(RESET_FIELDS.security).toContain('registration_mode')
    expect(COMPARE_FIELDS.security).toContain('registration_mode')
  })
})
