import { useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatTimestamp } from '@/lib/datetime'

// Matches SignalExpectedRequest.note on the server.
const NOTE_MAX_LENGTH = 2000

/**
 * "Mark as expected" (MO-4 / JR-5): an optional note on why the move is not a
 * problem — a deploy, a campaign. The note becomes the chart annotation's text
 * on this bucket, so whoever opens the chart later reads the reason there.
 * Mounted only while open, so the note starts empty each time.
 */
export function ExpectedSignalDialog({
  bucket,
  scopeLabel,
  pending,
  onConfirm,
  onClose,
}: {
  bucket: string
  scopeLabel: string
  pending: boolean
  onConfirm: (note: string | null) => void
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const noteId = useId()
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <form
          noValidate
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm(note.trim() || null)
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark as expected</DialogTitle>
            <DialogDescription>
              {scopeLabel} at {formatTimestamp(bucket)}. The signal is hidden from the open
              list and counts, and an annotation is added to the chart on this bucket.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-2">
            <Label htmlFor={noteId} optional>Why was it expected?</Label>
            <Textarea
              id={noteId}
              value={note}
              maxLength={NOTE_MAX_LENGTH}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. Spring campaign launch"
              rows={3}
            />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Mark as expected
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
