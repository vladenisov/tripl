import type { DbType, JsonPathDiscovery } from '@/types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HELP_CLASS, SELECT_CLASS, TEXTAREA_CLASS } from './connection-settings'
import type { ConnectionCoreForm } from './connection-core'

// ClickHouse JSON path discovery options (the preview step that enumerates
// candidate JSON paths). Defaults to "dynamic" — the effective backend default
// when the stored value is null.
const JSON_PATH_DISCOVERY_OPTIONS: { value: JsonPathDiscovery; label: string }[] = [
  { value: 'dynamic', label: 'Dynamic (recommended)' },
  { value: 'all', label: 'All paths' },
]

const JSON_PATH_DISCOVERY_HELP =
  'Dynamic lists only the important typed JSON sub-paths (faster). ' +
  'All lists every path including rarely-used ones (slower, exhaustive).'

// Every warehouse honours the timeout — including BigQuery, which used to get no
// deadline at all. The field is therefore shown for all of them; the placeholder
// stands for the server-side default (300s).
const TIMEOUT_HELP =
  'Connect and query budget. A query that outruns it is cancelled instead of holding a worker. ' +
  'Empty means the 300s default.'

interface ConnectionCoreFieldsProps {
  idPrefix: string
  dbType: DbType
  value: ConnectionCoreForm
  onChange: (patch: Partial<ConnectionCoreForm>) => void
  /**
   * 'create' requires a secret up front. 'edit' never pre-fills one (the API does
   * not return it) and keeps the stored secret when the field is left empty.
   */
  mode: 'create' | 'edit'
  /** True when the source already stores a password / service-account key. */
  secretSet?: boolean
}

/**
 * The core connection controls that apply to `dbType`, and nothing else — the
 * single implementation shared by the create and the edit dialog, so the two can
 * no longer drift apart.
 *
 * BigQuery has no host, no port and no username: it is a project id, a default
 * dataset and a service-account key. Showing it a "Port" box (which the adapter
 * deletes) or cramming a JSON key into a one-line password input was the bug
 * this component exists to prevent.
 */
export function ConnectionCoreFields({
  idPrefix,
  dbType,
  value,
  onChange,
  mode,
  secretSet = false,
}: ConnectionCoreFieldsProps) {
  const isEdit = mode === 'edit'
  const secretName = dbType === 'bigquery' ? 'Service account key' : 'Password'

  // On edit the secret is write-only: we can say whether one is stored, never
  // what it is. An empty field therefore means "keep what is stored".
  const secretStatus = isEdit ? (
    <p className={HELP_CLASS}>
      {secretSet
        ? `${secretName}: set. Leave empty to keep it — it is never sent back to the browser.`
        : `${secretName}: not set.`}
    </p>
  ) : null

  return (
    <>
      {dbType === 'bigquery' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor={`${idPrefix}-project-id`}>Project ID</Label>
              <Input
                id={`${idPrefix}-project-id`}
                value={value.host}
                onChange={(e) => onChange({ host: e.target.value })}
                required
                placeholder="my-gcp-project"
              />
              <p className={HELP_CLASS}>
                The GCP project the queries run in and that gets billed for the bytes they scan.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${idPrefix}-default-dataset`}>Default dataset</Label>
              <Input
                id={`${idPrefix}-default-dataset`}
                value={value.databaseName}
                onChange={(e) => onChange({ databaseName: e.target.value })}
                required
                placeholder="analytics"
              />
              <p className={HELP_CLASS}>
                Where unqualified table names resolve. Anything else must be in the dataset
                allowlist below.
              </p>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-service-account-json`}>Service account JSON</Label>
            <textarea
              id={`${idPrefix}-service-account-json`}
              value={value.secret}
              onChange={(e) => onChange({ secret: e.target.value })}
              required={!isEdit}
              rows={6}
              placeholder={
                isEdit && secretSet
                  ? 'A key is stored. Leave empty to keep it.'
                  : '{"type":"service_account", ...}'
              }
              className={TEXTAREA_CLASS}
            />
            {secretStatus ?? (
              <p className={HELP_CLASS}>
                The whole key file. Stored encrypted and never shown again.
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-5 gap-3">
            <div className="col-span-2 grid gap-2">
              <Label htmlFor={`${idPrefix}-host`}>Host</Label>
              <Input
                id={`${idPrefix}-host`}
                value={value.host}
                onChange={(e) => onChange({ host: e.target.value })}
                required
                placeholder="localhost"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${idPrefix}-port`}>Port</Label>
              <Input
                id={`${idPrefix}-port`}
                type="number"
                value={value.port}
                onChange={(e) => onChange({ port: Number(e.target.value) })}
                required
              />
            </div>
            <div className="col-span-2 grid gap-2">
              <Label htmlFor={`${idPrefix}-database`}>Database</Label>
              <Input
                id={`${idPrefix}-database`}
                value={value.databaseName}
                onChange={(e) => onChange({ databaseName: e.target.value })}
                required
                placeholder="default"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor={`${idPrefix}-username`}>Username</Label>
              <Input
                id={`${idPrefix}-username`}
                value={value.username}
                onChange={(e) => onChange({ username: e.target.value })}
                placeholder="default"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`${idPrefix}-password`}>Password</Label>
              <Input
                id={`${idPrefix}-password`}
                type="password"
                value={value.secret}
                onChange={(e) => onChange({ secret: e.target.value })}
                placeholder={isEdit ? 'Leave empty to keep' : '••••••••'}
              />
              {secretStatus}
            </div>
          </div>
        </>
      )}

      {/* Applies to every warehouse — BigQuery included. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-timeout`}>Timeout, s</Label>
          <Input
            id={`${idPrefix}-timeout`}
            type="number"
            min={1}
            step={1}
            value={value.timeoutSeconds}
            onChange={(e) => onChange({ timeoutSeconds: e.target.value })}
            placeholder="Default"
          />
          <p className={HELP_CLASS}>{TIMEOUT_HELP}</p>
        </div>
      </div>

      {dbType === 'clickhouse' && (
        <div className="grid gap-2">
          <Label htmlFor={`${idPrefix}-json-path-discovery`}>JSON path discovery</Label>
          <select
            id={`${idPrefix}-json-path-discovery`}
            value={value.jsonPathDiscovery}
            onChange={(e) => onChange({ jsonPathDiscovery: e.target.value as JsonPathDiscovery })}
            className={SELECT_CLASS}
          >
            {JSON_PATH_DISCOVERY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className={HELP_CLASS}>{JSON_PATH_DISCOVERY_HELP}</p>
        </div>
      )}
    </>
  )
}
