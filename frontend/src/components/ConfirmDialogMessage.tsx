import type { ReactNode } from 'react'
import { AlertDialogDescription } from '@/components/ui/alert-dialog'

/**
 * The description. A string stays the paragraph AlertDialogDescription
 * renders; rich content gets a <div>, because a list or a second paragraph is
 * invalid inside a <p>.
 */
export function ConfirmDialogMessage({ message }: { message: ReactNode }) {
  if (typeof message === 'string' || typeof message === 'number') {
    return <AlertDialogDescription>{message}</AlertDialogDescription>
  }
  return (
    <AlertDialogDescription asChild>
      <div>{message}</div>
    </AlertDialogDescription>
  )
}
