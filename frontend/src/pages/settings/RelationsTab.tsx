import { useId, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link2, Plus, Trash2 } from "lucide-react"
import { eventTypesApi } from "@/api/eventTypes"
import { relationsApi } from "@/api/relations"
import { useActiveBranchId } from "@/hooks/useBranch"
import type { EventType, EventTypeRelation } from "@/types"
import { useConfirm } from "@/hooks/useConfirm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { Panel } from "@/components/settings/kit"
import { getErrorMessage } from '@/lib/utils'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { eventTypesKey, relationsKey } from '@/lib/queryKeys'
import { useCanWriteProject } from '@/lib/permissions'
import { ReadOnlyNotice } from '@/components/read-only-notice'

export function RelationsTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const canWrite = useCanWriteProject()
  const branchId = useActiveBranchId()
  const [showForm, setShowForm] = useState(false)
  const [srcEtId, setSrcEtId] = useState('')
  const [tgtEtId, setTgtEtId] = useState('')
  const [srcFieldId, setSrcFieldId] = useState('')
  const [tgtFieldId, setTgtFieldId] = useState('')
  const { confirm, dialog } = useConfirm()

  const srcEtLabelId = useId()
  const tgtEtLabelId = useId()
  const srcFieldLabelId = useId()
  const tgtFieldLabelId = useId()

  const typesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug, branchId),
  })
  const relationsQuery = useQuery({
    queryKey: relationsKey(slug, branchId),
    queryFn: () => relationsApi.list(slug, branchId),
    // Rendered in the panel below, with a retry.
    meta: SILENT_ERROR_META,
  })
  const eventTypes = typesQuery.data ?? []
  const relations = relationsQuery.data ?? []

  const srcEt = eventTypes.find((e: EventType) => e.id === srcEtId)
  const tgtEt = eventTypes.find((e: EventType) => e.id === tgtEtId)

  const createMut = useMutation({
    mutationFn: () => relationsApi.create(slug, {
      source_event_type_id: srcEtId, target_event_type_id: tgtEtId,
      source_field_id: srcFieldId, target_field_id: tgtFieldId,
    }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: relationsKey(slug, branchId) })
      setShowForm(false); setSrcEtId(''); setTgtEtId(''); setSrcFieldId(''); setTgtFieldId('')
    },
  })

  const deleteMut = useMutation({
    // Its error is rendered under the table.
    meta: SILENT_ERROR_META,
    mutationFn: (id: string) => relationsApi.del(slug, id, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: relationsKey(slug, branchId) }),
  })

  const etMap: Record<string, EventType | undefined> = Object.fromEntries(
    eventTypes.map((e: EventType) => [e.id, e]),
  )
  // A relation IS its two fields: two relations between the same pair of types
  // differ only there, so a row (and a delete confirm) naming only the types
  // could not say which one it meant (PLAN-52).
  const endpoint = (typeId: string, fieldId: string) => {
    const et = etMap[typeId]
    const fieldName = et?.field_definitions.find(f => f.id === fieldId)?.name
    return `${et?.name ?? '?'}.${fieldName ?? '?'}`
  }

  const handleDelete = async (r: EventTypeRelation) => {
    deleteMut.reset()
    const source = endpoint(r.source_event_type_id, r.source_field_id)
    const target = endpoint(r.target_event_type_id, r.target_field_id)
    const ok = await confirm({
      title: 'Delete relation',
      message: `Remove the relation ${source} → ${target}?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(r.id)
  }

  return (
    <div className="space-y-4">
      {dialog}
      {!canWrite && <ReadOnlyNotice />}

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Relation</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor={srcEtLabelId}>Source Event Type</Label>
                  <select id={srcEtLabelId} value={srcEtId} onChange={e => { setSrcEtId(e.target.value); setSrcFieldId('') }} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {eventTypes.map((et: EventType) => <option key={et.id} value={et.id}>{et.display_name}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={tgtEtLabelId}>Target Event Type</Label>
                  <select id={tgtEtLabelId} value={tgtEtId} onChange={e => { setTgtEtId(e.target.value); setTgtFieldId('') }} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {eventTypes.map((et: EventType) => <option key={et.id} value={et.id}>{et.display_name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor={srcFieldLabelId}>Source Field</Label>
                  <select id={srcFieldLabelId} value={srcFieldId} onChange={e => setSrcFieldId(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {srcEt?.field_definitions.map(f => <option key={f.id} value={f.id}>{f.display_name}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={tgtFieldLabelId}>Target Field</Label>
                  <select id={tgtFieldLabelId} value={tgtFieldId} onChange={e => setTgtFieldId(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {tgtEt?.field_definitions.map(f => <option key={f.id} value={f.id}>{f.display_name}</option>)}
                  </select>
                </div>
              </div>
              {createMut.isError && <p className="text-sm text-destructive">{getErrorMessage(createMut.error)}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" disabled={!srcFieldId || !tgtFieldId || createMut.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Panel
        title="Relations"
        subtitle={relationsQuery.isPending
          ? 'Loading…'
          : `${relations.length} relation${relations.length === 1 ? '' : 's'}`}
        right={
          canWrite && (
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Plus className="mr-2 h-4 w-4" />Add relation
            </Button>
          )
        }
      >
        {relationsQuery.isError && relationsQuery.data !== undefined && (
          // A failed REFRESH keeps the rows on screen: replacing them with an
          // error would unmount whatever is being edited (review 204).
          <p role="alert" className="px-4 py-2 text-xs text-destructive">
            Couldn't refresh relations: {getErrorMessage(relationsQuery.error)}
          </p>
        )}
        {relationsQuery.isPending ? (
          // A pending list is not an empty one: "No relations" used to flash on
          // every cold load (PLAN-41).
          <div className="space-y-2 px-4 py-4" aria-busy="true" aria-label="Loading relations">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : relationsQuery.isError && relationsQuery.data === undefined ? (
          <div className="p-4">
            <ErrorState
              compact
              title="Couldn't load relations"
              error={relationsQuery.error}
              onRetry={() => { void relationsQuery.refetch() }}
              retryLabel="Retry"
            />
          </div>
        ) : relations.length > 0 ? (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="w-8"><span className="sr-only">Joins</span></TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="w-16"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {relations.map((r: EventTypeRelation) => {
                  const source = endpoint(r.source_event_type_id, r.source_field_id)
                  const target = endpoint(r.target_event_type_id, r.target_field_id)
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{source}</TableCell>
                      <TableCell className="text-muted-foreground" aria-hidden="true">→</TableCell>
                      <TableCell className="font-mono text-xs">{target}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{r.relation_type}</TableCell>
                      <TableCell>
                        {canWrite && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            aria-label={`Delete relation between ${source} and ${target}`}
                            disabled={deleteMut.isPending}
                            onClick={() => handleDelete(r)}
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            {deleteMut.isError && (
              <p role="alert" className="px-4 py-2 text-sm text-destructive">
                Could not delete the relation: {getErrorMessage(deleteMut.error)}
              </p>
            )}
          </>
        ) : (
          <div className="px-4 py-8">
            <EmptyState icon={Link2} title="No relations" description="Link event types by a shared field so drift and coverage can follow the join — e.g. connect Purchase.user_id to Signup.user_id." />
          </div>
        )}
      </Panel>
    </div>
  )
}
