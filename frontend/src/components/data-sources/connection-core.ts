import type { DataSource, DbType, JsonPathDiscovery } from '@/types'

/**
 * Form state for the *core* connection fields — the ones that live on the data
 * source row itself (host/port/database/username/password/timeout), as opposed
 * to the typed per-warehouse `connection_settings` handled by
 * `./connection-settings`.
 *
 * What a field *means* depends on the warehouse:
 *   - `host`         → the GCP project id for BigQuery, a hostname elsewhere
 *   - `databaseName` → the default dataset for BigQuery, a database elsewhere
 *   - `secret`       → the service-account JSON for BigQuery, a password elsewhere
 *   - `port`/`username` → meaningless for BigQuery (`BigQueryAdapter.__init__`
 *     deletes both), so they are neither shown nor sent for it.
 *
 * `secret` is write-only. The API never returns a password or a service-account
 * key (only the `password_set` boolean), so it always starts empty on edit and
 * an untouched field keeps whatever is stored.
 */
export interface ConnectionCoreForm {
  host: string
  port: number
  databaseName: string
  username: string
  secret: string
  timeoutSeconds: string
  jsonPathDiscovery: JsonPathDiscovery
}

export const EMPTY_CONNECTION_CORE_FORM: ConnectionCoreForm = {
  host: '',
  port: 8123,
  databaseName: '',
  username: '',
  secret: '',
  timeoutSeconds: '',
  jsonPathDiscovery: 'dynamic',
}

/**
 * Prefill the edit form from a saved source. The secret is deliberately left
 * empty: the GET never returns it, so echoing anything here would be a lie (and
 * would risk sending a placeholder back as a real credential).
 */
export function dataSourceToCoreForm(ds: DataSource): ConnectionCoreForm {
  return {
    host: ds.host,
    port: ds.port,
    databaseName: ds.database_name,
    username: ds.username,
    secret: '',
    timeoutSeconds: ds.timeout_seconds == null ? '' : String(ds.timeout_seconds),
    jsonPathDiscovery: ds.json_path_discovery ?? 'dynamic',
  }
}

export function parseTimeoutSeconds(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

interface CoreCreatePayload {
  host: string
  port: number
  database_name: string
  username: string
  password: string
  timeout_seconds: number | null
  json_path_discovery?: JsonPathDiscovery
}

interface CoreUpdatePayload {
  host: string
  port?: number
  database_name: string
  username?: string
  password?: string
  timeout_seconds: number | null
  json_path_discovery?: JsonPathDiscovery
}

/**
 * The POST body for the core fields. BigQuery still sends the (unused) port and
 * username because `DataSourceCreate` defaults them to 8123/"" anyway — sending
 * the defaults keeps the create contract exactly as it was.
 */
export function buildCoreCreatePayload(
  dbType: DbType,
  form: ConnectionCoreForm,
): CoreCreatePayload {
  return {
    host: form.host,
    port: form.port,
    database_name: form.databaseName,
    username: form.username,
    password: form.secret,
    // Every warehouse honours the timeout, BigQuery included.
    timeout_seconds: parseTimeoutSeconds(form.timeoutSeconds),
    ...(dbType === 'clickhouse' ? { json_path_discovery: form.jsonPathDiscovery } : {}),
  }
}

/**
 * The PATCH body for the core fields.
 *
 * BigQuery omits `port` and `username` entirely — the adapter deletes them, so
 * the edit dialog does not show them and must not write them back. The secret is
 * only sent when the operator actually typed one; omitting it keeps the stored
 * password / service-account key, exactly like an omitted `sslkey`.
 */
export function buildCoreUpdatePayload(
  dbType: DbType,
  form: ConnectionCoreForm,
): CoreUpdatePayload {
  const timeout_seconds = parseTimeoutSeconds(form.timeoutSeconds)

  if (dbType === 'bigquery') {
    return {
      host: form.host,
      database_name: form.databaseName,
      ...(form.secret ? { password: form.secret } : {}),
      timeout_seconds,
    }
  }

  return {
    host: form.host,
    port: form.port,
    database_name: form.databaseName,
    username: form.username,
    ...(form.secret ? { password: form.secret } : {}),
    timeout_seconds,
    ...(dbType === 'clickhouse' ? { json_path_discovery: form.jsonPathDiscovery } : {}),
  }
}
