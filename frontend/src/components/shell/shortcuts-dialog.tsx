import type { ReactNode } from 'react'
import { Kbd } from '@/components/primitives/kbd'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { commandPaletteShortcutLabel } from '@/lib/platform'

/**
 * The `?` sheet (JR-21): every key the app answers to, in one place. There
 * was no shortcut help at all, so `/` and Ctrl K were found by accident.
 * Loaded on the first `?`, never on a page load.
 */
export default function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Letter keys work anywhere outside a text field.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <dl className="divide-y divide-border-subtle text-body-sm">
            <Shortcut keys={<Kbd>{commandPaletteShortcutLabel()}</Kbd>}>Search or jump to a page</Shortcut>
            <Shortcut keys={<Kbd>/</Kbd>}>Search the list on this page</Shortcut>
            <Shortcut keys={<Kbd>C</Kbd>}>Create on this page (New event, New metric…)</Shortcut>
            <Shortcut keys={<Kbd>?</Kbd>}>Show these shortcuts</Shortcut>
            <Shortcut keys={<Kbd>Esc</Kbd>}>Close a dialog, menu or drawer</Shortcut>
          </dl>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function Shortcut({ keys, children }: { keys: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <dt className="text-fg">{children}</dt>
      <dd className="shrink-0">{keys}</dd>
    </div>
  )
}
