import type {
  ConnectionSettings,
  ConnectionSettingsResponse,
  DbType,
  PostgresSslMode,
} from '@/types'

// Form state for the typed, per-warehouse connection settings. Kept as strings
// (what inputs produce) and converted to the API shape by
// `buildConnectionSettings`, which only ever emits the settings that apply to
// the selected warehouse — the backend rejects the rest with a 422.
export interface ConnectionSettingsForm {
  // BigQuery
  location: string
  maximumBytesBilled: string
  datasetAllowlist: string
  // PostgreSQL
  sslmode: PostgresSslMode | ''
  sslrootcert: string
  sslcert: string
  sslkey: string
  clearSslkey: boolean
  searchPath: string
}

export const EMPTY_CONNECTION_SETTINGS_FORM: ConnectionSettingsForm = {
  location: '',
  maximumBytesBilled: '',
  datasetAllowlist: '',
  sslmode: '',
  sslrootcert: '',
  sslcert: '',
  sslkey: '',
  clearSslkey: false,
  searchPath: '',
}

// '' means "use the server-side default", which for PostgreSQL is 'prefer'.
export const SSL_MODE_OPTIONS: { value: PostgresSslMode | ''; label: string }[] = [
  { value: '', label: 'Default (prefer)' },
  { value: 'disable', label: 'disable — never use TLS' },
  { value: 'allow', label: 'allow — TLS only if the server insists' },
  { value: 'prefer', label: 'prefer — TLS if available, plaintext otherwise' },
  { value: 'require', label: 'require — TLS, but the certificate is not checked' },
  { value: 'verify-ca', label: 'verify-ca — TLS and the certificate must chain to the CA' },
  { value: 'verify-full', label: 'verify-full — verify-ca plus a hostname match' },
]

// ~100 GiB, mirroring DEFAULT_BIGQUERY_MAXIMUM_BYTES_BILLED on the backend.
export const DEFAULT_MAX_BILLED_BYTES_LABEL = '107374182400'

export const SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export const TEXTAREA_CLASS =
  'flex w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

export const HELP_CLASS = 'text-xs text-muted-foreground'

function parseAllowlist(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function nullable(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Convert the form into the API payload for the selected warehouse.
 *
 * Returns `undefined` for warehouses without settings so the caller can leave
 * `connection_settings` out of the request entirely. Cleared fields are sent as
 * `null` (the PATCH replaces settings wholesale). `sslkey` is only sent when the
 * operator typed a new key, or explicitly asked to remove the stored one — an
 * omitted `sslkey` keeps whatever is stored, exactly like an omitted password.
 */
export function buildConnectionSettings(
  dbType: DbType,
  form: ConnectionSettingsForm,
): ConnectionSettings | undefined {
  if (dbType === 'bigquery') {
    const maxBytes = form.maximumBytesBilled.trim()
    const datasets = parseAllowlist(form.datasetAllowlist)
    return {
      location: nullable(form.location),
      maximum_bytes_billed: maxBytes ? Number(maxBytes) : null,
      dataset_allowlist: datasets.length > 0 ? datasets : null,
    }
  }

  if (dbType === 'postgres') {
    const sslkey = form.sslkey.trim()
    return {
      sslmode: form.sslmode === '' ? null : form.sslmode,
      sslrootcert: nullable(form.sslrootcert),
      sslcert: nullable(form.sslcert),
      search_path: nullable(form.searchPath),
      ...(sslkey ? { sslkey } : {}),
      ...(!sslkey && form.clearSslkey ? { sslkey: '' } : {}),
    }
  }

  return undefined
}

/** Prefill the form from a saved source (the private key is never sent back). */
export function connectionSettingsToForm(
  settings: ConnectionSettingsResponse | null | undefined,
): ConnectionSettingsForm {
  if (!settings) return EMPTY_CONNECTION_SETTINGS_FORM
  return {
    location: settings.location ?? '',
    maximumBytesBilled:
      settings.maximum_bytes_billed == null ? '' : String(settings.maximum_bytes_billed),
    datasetAllowlist: (settings.dataset_allowlist ?? []).join(', '),
    sslmode: settings.sslmode ?? '',
    sslrootcert: settings.sslrootcert ?? '',
    sslcert: settings.sslcert ?? '',
    sslkey: '',
    clearSslkey: false,
    searchPath: settings.search_path ?? '',
  }
}
