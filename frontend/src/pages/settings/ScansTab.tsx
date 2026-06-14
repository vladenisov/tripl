import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, Search } from "lucide-react"
import { dataSourcesApi } from "@/api/dataSources"
import { scansApi } from "@/api/scans"
import type { DataSource, ScanConfig } from "@/types"
import { useConfirm } from "@/hooks/useConfirm"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { ScanConfigRow } from "./scans/ScanConfigRow"
import { ScanCreateDialog } from "./scans/ScanConfigForm"

export function ScansTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [showForm, setShowForm] = useState(false)
  const { confirm, dialog } = useConfirm()

  const { data: dataSources = [] } = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => dataSourcesApi.list(),
  })

  const { data: scanConfigs = [] } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })

  const dsMap = useMemo(
    () => new Map(dataSources.map((ds: DataSource) => [ds.id, ds.name])),
    [dataSources],
  )

  const deleteMut = useMutation({
    mutationFn: (scanId: string) => scansApi.del(slug, scanId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scans', slug] }),
  })

  const handleDelete = async (sc: ScanConfig) => {
    const ok = await confirm({
      title: 'Delete scan config',
      message: `Delete "${sc.name}"?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(sc.id)
  }

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Scan Configs</h2>
        <Button onClick={() => setShowForm(true)} disabled={dataSources.length === 0}
          title={dataSources.length === 0 ? 'Add a data source first' : ''}>
          <Plus className="mr-2 h-4 w-4" />Add Scan Config
        </Button>
      </div>

      {dataSources.length === 0 && (
        <EmptyState icon={Search} title="No data sources" description="Add a data source connection first (via the global Data Sources page) to create scan configs." />
      )}

      <ScanCreateDialog
        slug={slug}
        open={showForm}
        onClose={() => setShowForm(false)}
      />

      {scanConfigs.map((sc: ScanConfig) => (
        <ScanConfigRow
          key={sc.id}
          sc={sc}
          dsName={dsMap.get(sc.data_source_id) ?? 'Unknown'}
          onNavigate={() => navigate(`/p/${slug}/settings/scans/${sc.id}`)}
          onDelete={() => handleDelete(sc)}
        />
      ))}
    </div>
  )
}
