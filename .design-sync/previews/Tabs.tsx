import { Tabs, TabsContent, TabsList, TabsTrigger } from 'frontend'

export const Default = () => (
  <Tabs defaultValue="overview" style={{ width: 420 }}>
    <TabsList>
      <TabsTrigger value="overview">Overview</TabsTrigger>
      <TabsTrigger value="queries">Queries</TabsTrigger>
      <TabsTrigger value="settings">Settings</TabsTrigger>
    </TabsList>
    <TabsContent value="overview" style={{ paddingTop: 12, fontSize: 13, color: 'var(--fg-subtle)' }}>
      Cluster is healthy. 1.84B rows scanned in the last hour with a p95 latency of 142 ms.
    </TabsContent>
    <TabsContent value="queries" style={{ paddingTop: 12, fontSize: 13, color: 'var(--fg-subtle)' }}>
      12 saved queries · 3 scheduled.
    </TabsContent>
    <TabsContent value="settings" style={{ paddingTop: 12, fontSize: 13, color: 'var(--fg-subtle)' }}>
      Retention, access, and billing settings for this workspace.
    </TabsContent>
  </Tabs>
)

export const TwoTabs = () => (
  <Tabs defaultValue="diff" style={{ width: 420 }}>
    <TabsList>
      <TabsTrigger value="diff">Diff</TabsTrigger>
      <TabsTrigger value="raw">Raw</TabsTrigger>
    </TabsList>
    <TabsContent value="diff" style={{ paddingTop: 12, fontSize: 13, color: 'var(--fg-subtle)' }}>
      4 columns added, 1 removed since the last reconciliation.
    </TabsContent>
    <TabsContent value="raw" style={{ paddingTop: 12, fontSize: 13, color: 'var(--fg-subtle)' }}>
      Showing the unprocessed source payload.
    </TabsContent>
  </Tabs>
)
