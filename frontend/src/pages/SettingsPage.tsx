import { lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { useAuth } from '@/components/auth-context'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  SERVICE_SETTINGS_TABS,
  type ServiceSettingsSectionKey,
} from './serviceSettingsTabs'

const DataSourcesPage = lazy(() => import('./DataSourcesPage'))
const UsersPage = lazy(() => import('./UsersPage'))
const AccountPage = lazy(() => import('./AccountPage'))
const ServiceSettingsSection = lazy(() => import('./ServiceSettingsPage'))

const BASE_TABS = [
  { value: 'data-sources', label: 'Data Sources' },
  { value: 'users', label: 'Users' },
  { value: 'account', label: 'Account' },
] as const

const SERVICE_TAB_KEYS = new Set<string>(SERVICE_SETTINGS_TABS.map(tab => tab.value))

function TabFallback() {
  return <div className="text-sm text-muted-foreground">Loading…</div>
}

export default function SettingsPage() {
  const { tab: urlTab, dsId } = useParams<{ tab?: string; dsId?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isOwner = user?.role === 'owner'

  const tabs = isOwner ? [...BASE_TABS, ...SERVICE_SETTINGS_TABS] : [...BASE_TABS]
  const requested = dsId ? 'data-sources' : urlTab
  const tab = tabs.some(t => t.value === requested) ? requested! : 'data-sources'

  const changeTab = (t: string) => {
    navigate(`/settings/${t}`, { replace: true })
  }

  return (
    <div className="min-w-0">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Data sources, users, your account{isOwner ? ', and instance-level service settings' : ''}
        </p>
      </div>

      <Tabs value={tab} onValueChange={changeTab} className="mb-6 min-w-0">
        <TabsList>
          {tabs.map(t => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Suspense fallback={<TabFallback />}>
        {tab === 'data-sources' && <DataSourcesPage />}
        {tab === 'users' && <UsersPage />}
        {tab === 'account' && <AccountPage />}
        {SERVICE_TAB_KEYS.has(tab) && (
          <ServiceSettingsSection section={tab as ServiceSettingsSectionKey} />
        )}
      </Suspense>
    </div>
  )
}
