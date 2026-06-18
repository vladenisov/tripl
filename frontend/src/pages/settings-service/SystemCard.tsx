import { ServerCog } from 'lucide-react'
import type { SystemSettings } from '@/types'
import { Dot } from '@/components/primitives/dot'
import { SectionCard } from './ServiceSettingsPrimitives'

export function SystemCard({ system }: { system: SystemSettings }) {
  const rows: { label: string; active: boolean }[] = [
    { label: 'Debug mode', active: system.debug },
    { label: 'Database URL', active: system.database_url_configured },
    { label: 'Sync database URL', active: system.sync_database_url_configured },
    { label: 'RabbitMQ URL', active: system.rabbitmq_url_configured },
    { label: 'Redis URL', active: system.redis_url_configured },
    { label: 'Encryption key', active: system.encryption_key_configured },
    { label: 'OpenAI fallback key', active: system.openai_api_key_configured },
  ]

  return (
    <SectionCard title="System" icon={ServerCog}>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {rows.map(row => (
          <div
            key={row.label}
            className="flex flex-col gap-1.5 rounded-[10px] border px-3 py-2.5"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
          >
            <div className="flex items-center gap-1.5">
              <Dot tone={row.active ? 'success' : 'neutral'} pulse={row.active} size={7} />
              <span
                className="text-[10.5px] uppercase tracking-[0.05em]"
                style={{ color: 'var(--fg-faint)' }}
              >
                {row.label}
              </span>
            </div>
            <span
              className="text-[12.5px] font-medium"
              style={{ color: row.active ? 'var(--success)' : 'var(--fg-subtle)' }}
            >
              {row.active ? 'Configured' : 'Unset'}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}
