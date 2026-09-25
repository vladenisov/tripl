import { fieldErrorId } from './fieldErrors'

/** The message under an input, linked to it by {@link fieldErrorProps}. */
export function FieldError({ inputId, message }: { inputId: string; message: string | null | undefined }) {
  if (!message) return null
  return (
    <p id={fieldErrorId(inputId)} className="text-xs text-destructive">
      {message}
    </p>
  )
}
