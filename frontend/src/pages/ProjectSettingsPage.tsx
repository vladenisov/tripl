import { lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GeneralTab } from './settings/GeneralTab'
import { EventTypesTab } from './settings/EventTypesTab'
import { HistoryTab } from './settings/HistoryTab'
import { MetaFieldsTab } from './settings/MetaFieldsTab'
import { RelationsTab } from './settings/RelationsTab'
import { VariablesTab } from './settings/VariablesTab'
import { MonitoringTab } from './settings/MonitoringTab'
import { ScansTab } from './settings/ScansTab'

type SettingsTab =
  | 'general'
  | 'event-types'
  | 'meta-fields'
  | 'relations'
  | 'variables'
  | 'monitoring'
  | 'alerting'
  | 'scans'
  | 'history'
const ProjectAlertingTab = lazy(() => import('@/pages/ProjectAlertingTab'))

export default function ProjectSettingsPage() {
  const { slug, tab: urlTab } = useParams<{ slug: string; tab?: string }>()
  const navigate = useNavigate()
  const validTabs: SettingsTab[] = [
    'general',
    'event-types',
    'meta-fields',
    'relations',
    'variables',
    'monitoring',
    'alerting',
    'scans',
    'history',
  ]
  const tab: SettingsTab = validTabs.includes(urlTab as SettingsTab) ? (urlTab as SettingsTab) : 'general'

  const changeTab = (t: string) => {
    navigate(`/p/${slug}/settings/${t}`, { replace: true })
  }

  return (
    <div className="min-w-0">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Project Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure project details, event types, monitoring, and scanning</p>
      </div>

      <Tabs value={tab} onValueChange={changeTab} className="mb-6 min-w-0">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="event-types">Event Types</TabsTrigger>
          <TabsTrigger value="meta-fields">Meta Fields</TabsTrigger>
          <TabsTrigger value="relations">Relations</TabsTrigger>
          <TabsTrigger value="variables">Variables</TabsTrigger>
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
          <TabsTrigger value="alerting">Alerting</TabsTrigger>
          <TabsTrigger value="scans">Scans</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'general' && slug && <GeneralTab slug={slug} />}
      {tab === 'event-types' && slug && <EventTypesTab slug={slug} />}
      {tab === 'meta-fields' && slug && <MetaFieldsTab slug={slug} />}
      {tab === 'relations' && slug && <RelationsTab slug={slug} />}
      {tab === 'variables' && slug && <VariablesTab slug={slug} />}
      {tab === 'monitoring' && slug && <MonitoringTab slug={slug} />}
      {tab === 'alerting' && slug && (
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading alerting settings…</p>}>
          <ProjectAlertingTab slug={slug} />
        </Suspense>
      )}
      {tab === 'scans' && slug && <ScansTab slug={slug} />}
      {tab === 'history' && slug && <HistoryTab slug={slug} />}
    </div>
  )
}
