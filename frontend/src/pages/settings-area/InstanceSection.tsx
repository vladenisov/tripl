import { Suspense } from 'react'
import { Navigate } from 'react-router-dom'
import { lazyWithReload } from '@/lib/lazyWithReload'
import { SHeader } from '@/components/settings/kit'
import type { ServiceSettingsSectionKey } from '@/pages/serviceSettingsTabs'
import { InstanceSettingsSkeleton } from '@/pages/settings-service/ServiceSettingsPrimitives'

const ServiceSettingsSection = lazyWithReload(() => import('@/pages/ServiceSettingsPage'))

const META: Record<ServiceSettingsSectionKey, { title: string; description: string }> = {
  // No "takes effect on the next deploy" line here any more: all three runtime
  // fields are read fresh at request/task time, so this page was the one page
  // carrying a redeploy warning that it did not need, while Storage and
  // Observability — which really are startup-applied — carried none
  // (tripl-tezn). Each section now states its own timing from applyNote().
  runtime: {
    title: 'Runtime',
    description: 'Core server configuration for this tripl instance.',
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
  // An unknown section used to render Runtime under a URL (and a rail
  // highlight) that said otherwise. Correct the URL instead.
  if (!VALID.includes(section as ServiceSettingsSectionKey)) {
    return <Navigate to="/settings/instance/runtime" replace />
  }
  const key = section as ServiceSettingsSectionKey
  const meta = META[key]
  return (
    <div>
      <SHeader title={meta.title} description={meta.description} />
      <Suspense fallback={<InstanceSettingsSkeleton />}>
        <ServiceSettingsSection section={key} />
      </Suspense>
    </div>
  )
}
