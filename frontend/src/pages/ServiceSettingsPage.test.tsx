import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { serviceSettingsApi } from '@/api/serviceSettings'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import type { ServiceSettings } from '@/types'
import ServiceSettingsSection from './ServiceSettingsPage'
import { RESET_FIELDS } from './settings-service/serviceSettingsHelpers'

function ownerAuthValue(): AuthContextValue {
  return {
    user: {
      id: 'owner-1',
      email: 'owner@example.com',
      name: 'owner',
      role: 'owner',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: async () => {},
    refresh: () => {},
  }
}

const SETTINGS = {
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
    smtp_password_configured: true,
    smtp_use_tls: true,
    smtp_from_address: '',
  },
  ai: {
    ai_enabled: false,
    ai_base_url: '',
    ai_model: '',
    ai_api_key_configured: true,
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
  sources: {},
} as ServiceSettings

function renderSection(section: 'ai' | 'security' | 'storage') {
  vi.spyOn(serviceSettingsApi, 'get').mockResolvedValue(SETTINGS)
  // spyOn hands back the SAME spy for a property already spied, so without this
  // the call history accumulates across tests and "not.toHaveBeenCalled" reads
  // the previous test's reset.
  const update = vi.spyOn(serviceSettingsApi, 'update').mockResolvedValue(SETTINGS)
  update.mockClear()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={ownerAuthValue()}>
        <ServiceSettingsSection section={section} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
  return update
}

describe('Instance settings destructive actions', () => {
  /**
   * Both of these used to call the mutation straight from onClick: one click
   * nulled 13 overrides (including registration_mode, which applies live) or
   * deleted a stored key server-side, with no confirmation and no undo
   * (tripl-ifiy).
   */
  it('confirms before resetting a section, naming the section and its field count', async () => {
    const update = renderSection('security')

    fireEvent.click(await screen.findByRole('button', { name: /Reset to defaults/ }))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent(`Clear all ${RESET_FIELDS.security.length} Security & access`)
    expect(dialog).toHaveTextContent(/Self-service registration/)
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset section' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith({
      security: Object.fromEntries(RESET_FIELDS.security.map((field) => [field, null])),
    })
  })

  it('abandons the reset when the confirmation is declined', async () => {
    const update = renderSection('storage')

    fireEvent.click(await screen.findByRole('button', { name: /Reset to defaults/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(update).not.toHaveBeenCalled()
  })

  it('confirms before a per-secret Clear deletes the stored key', async () => {
    const update = renderSection('ai')

    const clearButtons = await screen.findAllByRole('button', { name: 'Clear' })
    fireEvent.click(clearButtons[0]!)

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete the stored AI API key')
    // The field beside the button waits for Save changes; this does not.
    expect(dialog).toHaveTextContent(/does not wait for Save changes/)
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith({ ai: { ai_api_key: null } }))
  })
})

describe('Instance settings save row', () => {
  it('states when this section’s overrides start being obeyed', async () => {
    renderSection('storage')

    // Storage is startup-applied; the page used to say nothing at all, while
    // Runtime — which is read per request — carried the redeploy note
    // (tripl-tezn).
    expect(await screen.findByText(/after the next restart/i)).toBeInTheDocument()
  })

  it('offers Discard beside Save and keeps both reachable while the pane scrolls', async () => {
    renderSection('ai')

    const discard = await screen.findByRole('button', { name: 'Discard' })
    expect(discard).toBeDisabled()

    const row = discard.closest('div')?.parentElement
    expect(row?.className).toContain('sticky')
  })
})
