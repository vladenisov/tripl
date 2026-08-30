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
import { EmptyState } from "@/components/empty-state"
import { Panel } from "@/components/settings/kit"
import { getErrorMessage } from '@/lib/utils'
import { eventTypesKey } from '@/lib/queryKeys'

export function RelationsTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
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

  const { data: eventTypes = [] } = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug, branchId),
  })
  const { data: relations = [] } = useQuery({
    queryKey: ['relations', slug, branchId],
    queryFn: () => relationsApi.list(slug, branchId),
  })

  const srcEt = eventTypes.find((e: EventType) => e.id === srcEtId)
  const tgtEt = eventTypes.find((e: EventType) => e.id === tgtEtId)

  const createMut = useMutation({
    mutationFn: () => relationsApi.create(slug, {
      source_event_type_id: srcEtId, target_event_type_id: tgtEtId,
      source_field_id: srcFieldId, target_field_id: tgtFieldId,
    }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['relations', slug, branchId] })
      setShowForm(false); setSrcEtId(''); setTgtEtId(''); setSrcFieldId(''); setTgtFieldId('')
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => relationsApi.del(slug, id, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['relations', slug, branchId] }),
  })

  const handleDelete = async (r: EventTypeRelation) => {
    const ok = await confirm({
      title: 'Delete relation',
      message: 'Are you sure you want to remove this relation?',
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(r.id)
  }

  const etMap = Object.fromEntries(eventTypes.map((e: EventType) => [e.id, e]))

  return (
    <div className="space-y-4">
      {dialog}

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Relation</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
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
              <div className="grid grid-cols-2 gap-3">
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
        subtitle={`${relations.length} relation${relations.length === 1 ? '' : 's'}`}
        right={
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />Add relation
          </Button>
        }
      >
        {relations.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="w-8"></TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {relations.map((r: EventTypeRelation) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{etMap[r.source_event_type_id]?.name ?? '?'}</TableCell>
                  <TableCell className="text-muted-foreground">→</TableCell>
                  <TableCell className="font-mono text-xs">{etMap[r.target_event_type_id]?.name ?? '?'}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{r.relation_type}</TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Delete relation between ${etMap[r.source_event_type_id]?.name ?? '?'} and ${etMap[r.target_event_type_id]?.name ?? '?'}`} onClick={() => handleDelete(r)}><Trash2 className="h-3 w-3" aria-hidden="true" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="px-4 py-8">
            <EmptyState icon={Link2} title="No relations" description="Link event types by a shared field so drift and coverage can follow the join — e.g. connect Purchase.user_id to Signup.user_id." />
          </div>
        )}
      </Panel>
    </div>
  )
}
