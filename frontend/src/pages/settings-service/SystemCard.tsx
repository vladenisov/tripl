import { ServerCog } from 'lucide-react'
import type { SystemSettings } from '@/types'
import { Dot } from '@/components/primitives/dot'
import { SCard } from '@/components/settings/kit'

/** The four judgements a row can carry. Narrower than DotTone on purpose. */
type SystemTone = 'neutral' | 'success' | 'warning' | 'danger'

type SystemRow = {
  label: string
  /** What the instance reports, in this row's own vocabulary. */
  value: string
  tone: SystemTone
  /** Stated only where the state changes what an operator should do next. */
  note?: string
}

const VALUE_COLOR: Record<SystemTone, string> = {
  neutral: 'var(--fg-subtle)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
}

/** A dependency the API cannot run without: unset is a failure, not a blank. */
function required(label: string, configured: boolean): SystemRow {
  return {
    label,
    value: configured ? 'Configured' : 'Unset',
    tone: configured ? 'success' : 'danger',
    note: configured ? undefined : 'Required — the API cannot reach this dependency.',
  }
}

/**
 * What this instance found in its environment at startup.
 *
 * Every row used to map `active -> success + pulse`, which rendered the two
 * rows that matter backwards: "Debug mode" on was a pulsing green "Configured"
 * while "Encryption key" unset was the same neutral grey as the optional OpenAI
 * fallback key (tripl-lgr4). `active` means "set", not "healthy" — and for
 * `debug` it means the opposite — so each row now states its own judgement.
 *
 * The judgements are the ones backend/src/tripl/config.py already makes:
 *  - `debug` true returns early from `assert_production_ready` (config.py:286),
 *    skipping every startup check, and lets CORS fall back to "*"
 *    (config.py:263). On is a warning, not a pass.
 *  - an empty ENCRYPTION_KEY is one of those refused-boot problems: "data-source
 *    and alert-destination secrets would be stored as plaintext"
 *    (config.py:291). Unset is danger, not neutral.
 *  - REDIS_URL and OPENAI_API_KEY are the only two that are genuinely optional:
 *    cache.py no-ops without Redis, and the OpenAI key is a fallback for the AI
 *    and embedding keys (config.py:348-351). Unset is neutral for those two and
 *    for nothing else.
 */
function systemRows(system: SystemSettings): SystemRow[] {
  return [
    {
      label: 'Debug mode',
      value: system.debug ? 'On' : 'Off',
      tone: system.debug ? 'warning' : 'success',
      note: system.debug
        ? 'Production startup checks are skipped and CORS falls back to "*".'
        : undefined,
    },
    required('Database URL', system.database_url_configured),
    required('Sync database URL', system.sync_database_url_configured),
    required('RabbitMQ URL', system.rabbitmq_url_configured),
    {
      label: 'Redis URL',
      value: system.redis_url_configured ? 'Configured' : 'Unset',
      tone: system.redis_url_configured ? 'success' : 'neutral',
      note: system.redis_url_configured
        ? undefined
        : 'Optional — caching and live updates stay off without it.',
    },
    {
      label: 'Encryption key',
      value: system.encryption_key_configured ? 'Configured' : 'Unset',
      tone: system.encryption_key_configured ? 'success' : 'danger',
      note: system.encryption_key_configured
        ? undefined
        : 'Data source and alert destination secrets are stored as plaintext.',
    },
    {
      label: 'OpenAI fallback key',
      value: system.openai_api_key_configured ? 'Configured' : 'Unset',
      tone: system.openai_api_key_configured ? 'success' : 'neutral',
      note: system.openai_api_key_configured
        ? undefined
        : 'Optional — only used when the AI or embedding key is blank.',
    },
  ]
}

export function SystemCard({ system }: { system: SystemSettings }) {
  const rows = systemRows(system)

  return (
    <SCard
      title="System"
      icon={<ServerCog className="h-4 w-4" />}
      description="Read from this instance's environment when the API started. None of it can be changed from the app — set the variable where the process gets its environment, then restart."
    >
      <div className="p-[18px]">
        <div className="grid gap-2.5 sm:grid-cols-3">
          {rows.map(row => (
            <div
              key={row.label}
              className="flex flex-col gap-1.5 rounded-[10px] border px-3 py-2.5"
              style={{
                // A tile that needs attention says so with its own border, not
                // only with a dot the eye skips on a seven-tile scan.
                borderColor:
                  row.tone === 'warning' || row.tone === 'danger'
                    ? `color-mix(in oklab, var(--${row.tone}) 45%, var(--border))`
                    : 'var(--border-subtle)',
                background: 'var(--bg-sunken)',
              }}
            >
              <div className="flex items-center gap-1.5">
                {/* Pulse is for the rows an operator should act on, not for
                    every row that happens to be set. */}
                <Dot
                  tone={row.tone}
                  pulse={row.tone === 'warning' || row.tone === 'danger'}
                  size={7}
                />
                <span
                  className="text-[10.5px] uppercase tracking-[0.05em]"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  {row.label}
                </span>
              </div>
              <span className="text-[12.5px] font-medium" style={{ color: VALUE_COLOR[row.tone] }}>
                {row.value}
              </span>
              {row.note && (
                <span className="text-[11px] leading-[1.4]" style={{ color: 'var(--fg-subtle)' }}>
                  {row.note}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </SCard>
  )
}
