import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { scansApi } from '@/api/scans'
import type { ScanConfig } from '@/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getErrorMessage } from '@/lib/utils'

function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function defaultReplayWindow(): { from: string; to: string } {
  const to = new Date()
  to.setMinutes(0, 0, 0)
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
  return { from: toDatetimeLocalValue(from), to: toDatetimeLocalValue(to) }
}

// Replays metrics for a past time window. Shared by the Configuration danger zone.
export function ReplayDialog({
  slug,
  scanConfig,
  open,
  onOpenChange,
}: {
  slug: string
  scanConfig: ScanConfig
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  // Seeded once with a sensible 24h window; the user can adjust before replaying.
  const [from, setFrom] = useState(() => defaultReplayWindow().from)
  const [to, setTo] = useState(() => defaultReplayWindow().to)

  const replayMut = useMutation({
    mutationFn: () => {
      if (!from || !to) throw new Error('Select a period to replay')
      const fromDate = new Date(from)
      const toDate = new Date(to)
      if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
        throw new Error('Period dates are invalid')
      }
      if (fromDate >= toDate) throw new Error('Start must be before end')
      return scansApi.replayMetrics(slug, scanConfig.id, {
        time_from: fromDate.toISOString(),
        time_to: toDate.toISOString(),
      })
    },
    onSuccess: () => {
      onOpenChange(false)
      qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] })
      qc.invalidateQueries({ queryKey: ['scans', slug] })
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={e => { e.preventDefault(); replayMut.mutate() }}
        >
          <DialogHeader>
            <DialogTitle>Replay metrics period</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>From</Label>
              <Input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label>To</Label>
              <Input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} required />
            </div>
          </div>
          {replayMut.isError && (
            <p className="text-sm" style={{ color: 'var(--danger)' }}>{getErrorMessage(replayMut.error)}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={replayMut.isPending}>
              <RotateCcw className="size-3" />
              {replayMut.isPending ? 'Starting…' : 'Replay period'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
