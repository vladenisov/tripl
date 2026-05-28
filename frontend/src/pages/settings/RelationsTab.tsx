import { useState } from "react"
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

export function RelationsTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const [showForm, setShowForm] = useState(false)
  const [srcEtId, setSrcEtId] = useState('')
  const [tgtEtId, setTgtEtId] = useState('')
  const [srcFieldId, setSrcFieldId] = useState('')
  const [tgtFieldId, setTgtFieldId] = useState('')
  const { confirm, dialog } = useConfirm()

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
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
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Relations</h2>
        <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add Relation</Button>
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Relation</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Source Event Type</Label>
                  <select value={srcEtId} onChange={e => { setSrcEtId(e.target.value); setSrcFieldId('') }} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {eventTypes.map((et: EventType) => <option key={et.id} value={et.id}>{et.display_name}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>Target Event Type</Label>
                  <select value={tgtEtId} onChange={e => { setTgtEtId(e.target.value); setTgtFieldId('') }} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {eventTypes.map((et: EventType) => <option key={et.id} value={et.id}>{et.display_name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Source Field</Label>
                  <select value={srcFieldId} onChange={e => setSrcFieldId(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {srcEt?.field_definitions.map(f => <option key={f.id} value={f.id}>{f.display_name}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>Target Field</Label>
                  <select value={tgtFieldId} onChange={e => setTgtFieldId(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    <option value="">Select...</option>
                    {tgtEt?.field_definitions.map(f => <option key={f.id} value={f.id}>{f.display_name}</option>)}
                  </select>
                </div>
              </div>
              {createMut.isError && <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" disabled={!srcFieldId || !tgtFieldId || createMut.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {relations.length > 0 ? (
        <div className="rounded-lg border">
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
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(r)}><Trash2 className="h-3 w-3" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState icon={Link2} title="No relations" description="Create relations to link event types by their fields." action={<Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add Relation</Button>} />
      )}
    </div>
  )
}
