import { ChevronRight, Trash2 } from 'lucide-react'
import type { ScanConfig } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export function ScanConfigRow({
  sc,
  dsName,
  onNavigate,
  onDelete,
}: {
  sc: ScanConfig
  dsName: string
  onNavigate: () => void
  onDelete: () => void
}) {
  return (
    <Card>
      <div
        className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onNavigate}
      >
        <div className="flex items-center gap-3">
          <span className="font-semibold">{sc.name}</span>
          <span className="text-muted-foreground text-sm">{dsName}</span>
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
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={e => { e.stopPropagation(); onDelete() }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
    </Card>
  )
}
