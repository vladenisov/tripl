import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Pencil } from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { useActiveBranchId } from '@/hooks/useBranch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScanDetail } from './ScanDetail'
import { ScanEditDialog } from './scans/ScanConfigForm'

export function ScanConfigDetail({ slug, scanConfigId }: { slug: string; scanConfigId: string }) {
  const navigate = useNavigate()
  const branchId = useActiveBranchId()
  const [editOpen, setEditOpen] = useState(false)

  const { data: scanConfigs = [], isSuccess: scansLoaded } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const sc = scanConfigs.find(s => s.id === scanConfigId)

  const goBack = () => navigate(`/p/${slug}/settings/scans`)

  if (scansLoaded && !sc) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          Back to Scans
        </Button>
        <p className="text-sm text-muted-foreground">Scan config not found.</p>
      </div>
    )
  }

  if (!sc) {
    return null
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
        <ArrowLeft className="h-4 w-4" />
        Back to Scans
      </Button>

      <ScanEditDialog
        key={editOpen ? sc.id : 'none'}
        slug={slug}
        scanConfig={editOpen ? sc : null}
        onClose={() => setEditOpen(false)}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold">{sc.name}</h2>
          {sc.interval && <Badge variant="outline" className="text-xs">⏱ {sc.interval}</Badge>}
          {sc.scan_lookback_hours && (
            <Badge variant="outline" className="text-xs">Lookback {sc.scan_lookback_hours}h</Badge>
          )}
          {sc.scan_row_limit && (
            <Badge variant="outline" className="text-xs">Scan cap {sc.scan_row_limit}</Badge>
          )}
          {sc.metrics_row_limit && (
            <Badge variant="outline" className="text-xs">Metrics cap {sc.metrics_row_limit}</Badge>
          )}
          {sc.json_value_paths.length > 0 && (
            <Badge variant="outline" className="text-xs">JSON keep {sc.json_value_paths.length}</Badge>
          )}
          {sc.metric_breakdown_columns.length > 0 && (
            <Badge variant="outline" className="text-xs">Breakdowns {sc.metric_breakdown_columns.length}</Badge>
          )}
          {sc.distribution_drift_fields.length > 0 && (
            <Badge variant="outline" className="text-xs">Distribution {sc.distribution_drift_fields.length}</Badge>
          )}
          {sc.event_group_rules.length > 0 && (
            <Badge variant="outline" className="text-xs">Groups {sc.event_group_rules.length}</Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} className="gap-1.5 shrink-0">
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
      </div>

      <ScanDetail slug={slug} scanConfig={sc} eventTypes={eventTypes} branchId={branchId} />
    </div>
  )
}
