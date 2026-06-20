import { lazy, Suspense } from 'react'
import { SHeader } from '@/components/settings/kit'
import type { ServiceSettingsSectionKey } from '@/pages/serviceSettingsTabs'

const ServiceSettingsSection = lazy(() => import('@/pages/ServiceSettingsPage'))

const META: Record<ServiceSettingsSectionKey, { title: string; description: string }> = {
  runtime: {
    title: 'Runtime',
    description: 'Core server configuration for this tripl instance. Overrides take effect on the next deploy.',
  },
  email: { title: 'Email', description: 'SMTP transport for invitations, alerts and digests.' },
  ai: {
    title: 'AI',
    description: 'Powers anomaly explanations, schema suggestions and the assistant.',
  },
  security: {
    title: 'Security & access',
    description: 'Authentication and network policy for everyone on this instance.',
  },
  storage: { title: 'Storage', description: 'Where ingested events and event photos are persisted.' },
  observability: {
    title: 'Observability',
    description: 'How tripl reports its own health to your monitoring stack.',
  },
  system: { title: 'System', description: 'Read-only health and build information for this instance.' },
}

const VALID: ServiceSettingsSectionKey[] = [
  'runtime',
  'email',
  'ai',
  'security',
  'storage',
  'observability',
  'system',
]

/**
 * Instance (owner-only). Mirrors the real ServiceSettings sections by reusing
 * the ServiceSettingsSection component wholesale — it self-fetches, owner-gates,
 * and owns all field wiring and mutations. We only frame it with the takeover
 * section header.
 */
export default function InstanceSection({ section }: { section: string }) {
  const key = (VALID.includes(section as ServiceSettingsSectionKey)
    ? section
    : 'runtime') as ServiceSettingsSectionKey
  const meta = META[key]
  return (
    <div>
      <SHeader title={meta.title} description={meta.description} />
      <Suspense
        fallback={<div className="text-sm" style={{ color: 'var(--fg-subtle)' }}>Loading…</div>}
      >
        <ServiceSettingsSection section={key} />
      </Suspense>
    </div>
  )
}
