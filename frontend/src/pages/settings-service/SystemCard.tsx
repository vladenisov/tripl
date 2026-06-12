import { ServerCog } from 'lucide-react'
import type { SystemSettings } from '@/types'
import { SectionCard, StatusBadge } from './ServiceSettingsPrimitives'

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
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map(row => (
          <div
            key={row.label}
            className="flex min-h-10 items-center justify-between gap-3 rounded-md border px-3"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <span className="text-xs text-muted-foreground">{row.label}</span>
            <StatusBadge active={row.active} label={row.active ? 'Configured' : 'Unset'} />
          </div>
        ))}
      </div>
    </SectionCard>
  )
}
