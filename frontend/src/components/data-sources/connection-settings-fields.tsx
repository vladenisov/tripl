import type { DbType, PostgresSslMode } from '@/types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  DEFAULT_MAX_BILLED_BYTES_LABEL,
  FIELD_COL_CLASS,
  HELP_CLASS,
  SELECT_CLASS,
  SSL_MODE_OPTIONS,
  TEXTAREA_CLASS,
  type ConnectionSettingsForm,
} from './connection-settings'

interface ConnectionSettingsFieldsProps {
  idPrefix: string
  dbType: DbType
  value: ConnectionSettingsForm
  onChange: (patch: Partial<ConnectionSettingsForm>) => void
  /** True when the source already has a stored client private key. */
  sslkeySet?: boolean
}

/**
 * The connection settings that apply to `dbType`, and nothing else. Each control
 * explains what it does, so none of these are the undocumented escape hatch that
 * `extra_params` used to be.
 */
export function ConnectionSettingsFields({
  idPrefix,
  dbType,
  value,
  onChange,
  sslkeySet = false,
}: ConnectionSettingsFieldsProps) {
  if (dbType === 'bigquery') {
    return (
      <>
        <div className="grid grid-cols-2 gap-3">
          <div className={FIELD_COL_CLASS}>
            <Label htmlFor={`${idPrefix}-location`}>Location</Label>
            <Input
              id={`${idPrefix}-location`}
              value={value.location}
              onChange={(e) => onChange({ location: e.target.value })}
              placeholder="EU, US, us-east1…"
            />
            <p className={HELP_CLASS}>
              The region or multi-region the datasets live in. Leave empty to let BigQuery infer it —
              a query started in the wrong location fails.
            </p>
          </div>
          <div className={FIELD_COL_CLASS}>
            <Label htmlFor={`${idPrefix}-max-billed-bytes`}>Max billed bytes</Label>
            <Input
              id={`${idPrefix}-max-billed-bytes`}
              type="number"
              min={1}
              step={1}
              value={value.maximumBytesBilled}
              onChange={(e) => onChange({ maximumBytesBilled: e.target.value })}
              placeholder={DEFAULT_MAX_BILLED_BYTES_LABEL}
            />
            <p className={HELP_CLASS}>
              Cost guard: BigQuery refuses a query estimated to bill more than this. Defaults to
              100 GiB per query.
            </p>
          </div>
        </div>
        <div className={FIELD_COL_CLASS}>
          <Label htmlFor={`${idPrefix}-dataset-allowlist`}>Dataset allowlist</Label>
          <Input
            id={`${idPrefix}-dataset-allowlist`}
            value={value.datasetAllowlist}
            onChange={(e) => onChange({ datasetAllowlist: e.target.value })}
            placeholder="analytics, marts, events_raw"
          />
          <p className={HELP_CLASS}>
            Comma-separated datasets the schema browser may list. Empty means the default dataset
            only.
          </p>
        </div>
      </>
    )
  }

  if (dbType === 'postgres') {
    return (
      <>
        <div className="grid grid-cols-2 gap-3">
          <div className={FIELD_COL_CLASS}>
            <Label htmlFor={`${idPrefix}-sslmode`}>SSL mode</Label>
            <select
              id={`${idPrefix}-sslmode`}
              value={value.sslmode}
              onChange={(e) => onChange({ sslmode: e.target.value as PostgresSslMode | '' })}
              className={SELECT_CLASS}
            >
              {SSL_MODE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className={HELP_CLASS}>
              How strictly TLS is enforced. `verify-full` is the only setting that also protects
              against a man-in-the-middle; it needs a CA certificate below.
            </p>
          </div>
          <div className={FIELD_COL_CLASS}>
            <Label htmlFor={`${idPrefix}-search-path`}>Search path</Label>
            <Input
              id={`${idPrefix}-search-path`}
              value={value.searchPath}
              onChange={(e) => onChange({ searchPath: e.target.value })}
              placeholder="public"
            />
            <p className={HELP_CLASS}>
              Comma-separated schemas to resolve unqualified table names against. Leave empty for
              the role's own default.
            </p>
          </div>
        </div>
        <div className={FIELD_COL_CLASS}>
          <Label htmlFor={`${idPrefix}-sslrootcert`}>CA certificate</Label>
          <textarea
            id={`${idPrefix}-sslrootcert`}
            value={value.sslrootcert}
            onChange={(e) => onChange({ sslrootcert: e.target.value })}
            rows={3}
            placeholder="-----BEGIN CERTIFICATE-----"
            className={TEXTAREA_CLASS}
          />
          <p className={HELP_CLASS}>
            PEM content (not a path on the server). Required by `verify-ca` and `verify-full`.
          </p>
        </div>
        <div className={FIELD_COL_CLASS}>
          <Label htmlFor={`${idPrefix}-sslcert`}>Client certificate</Label>
          <textarea
            id={`${idPrefix}-sslcert`}
            value={value.sslcert}
            onChange={(e) => onChange({ sslcert: e.target.value })}
            rows={3}
            placeholder="-----BEGIN CERTIFICATE-----"
            className={TEXTAREA_CLASS}
          />
          <p className={HELP_CLASS}>PEM content. Only needed for certificate (mTLS) auth.</p>
        </div>
        <div className={FIELD_COL_CLASS}>
          <Label htmlFor={`${idPrefix}-sslkey`}>Client private key</Label>
          <textarea
            id={`${idPrefix}-sslkey`}
            value={value.sslkey}
            onChange={(e) => onChange({ sslkey: e.target.value })}
            rows={3}
            placeholder={
              sslkeySet ? 'A key is stored. Leave empty to keep it.' : '-----BEGIN PRIVATE KEY-----'
            }
            className={TEXTAREA_CLASS}
            disabled={value.clearSslkey}
          />
          <p className={HELP_CLASS}>
            PEM content, stored encrypted and never shown again — like the password.
          </p>
          {sslkeySet && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={value.clearSslkey}
                onChange={(e) => onChange({ clearSslkey: e.target.checked, sslkey: '' })}
              />
              Remove the stored client private key
            </label>
          )}
        </div>
      </>
    )
  }

  return null
}
