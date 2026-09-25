import type { ComponentProps } from 'react'
import { Field } from '@/components/settings/kit'
import { fieldErrorId } from './fieldErrors'

/**
 * kit's Field has no `required` flag or error slot; this thin wrapper renders
 * the red required marker (kit's `labelRight` slot) and appends an inline error
 * message beneath the control (kit's `hint` sits in the label column, so the
 * error goes into the children column to read directly under the input).
 *
 * The message carries `${htmlFor}-error`, the id the control's
 * `aria-describedby` points at through {@link errorAria}. `errorFor` names the
 * id when the row has no single control (`htmlFor={false}`).
 */
export function MetricField({
  required,
  error,
  errorFor,
  children,
  ...props
}: {
  required?: boolean
  error?: string
  errorFor?: string
} & ComponentProps<typeof Field>) {
  const labelRight = required ? (
    <span aria-hidden="true" style={{ color: 'var(--danger)' }}>*</span>
  ) : (
    props.labelRight
  )
  const messageFor = errorFor ?? (typeof props.htmlFor === 'string' ? props.htmlFor : undefined)
  return (
    <Field {...props} labelRight={labelRight}>
      {children}
      {error && (
        <p
          id={messageFor ? fieldErrorId(messageFor) : undefined}
          className="mt-[6px] text-[12px] leading-[1.45]"
          style={{ color: 'var(--danger)' }}
        >
          {error}
        </p>
      )}
    </Field>
  )
}
