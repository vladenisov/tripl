/**
 * Layout primitives shared by the event authoring pages.
 *
 * Extracted verbatim from `EventForm.tsx`, where they were private, when a
 * second authoring surface appeared: the bulk page must look like the single
 * one, and two copies of a card and a labelled row is how two surfaces that are
 * meant to be the same screen quietly stop being it.
 */
import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { FormRow } from '@/components/ui/form-row'

export const EV_INPUT_CLASS =
  'w-full rounded-[7px] border bg-[var(--bg)] px-[11px] text-[13px] text-[var(--fg)] outline-none focus:border-[var(--accent)]'
export const SELECT_CLASS = `${EV_INPUT_CLASS} h-[34px] cursor-pointer appearance-none pr-[30px]`
export const TEXT_INPUT_CLASS = `${EV_INPUT_CLASS} h-[34px]`

export function SurfCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div
      className="mb-[18px] overflow-hidden rounded-[12px] border"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="border-b px-[18px] py-[14px]" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="text-[14px] font-semibold">{title}</div>
        {subtitle && (
          <div className="mt-[3px] text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

export function EvField({
  label,
  hint,
  htmlFor,
  required,
  last,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  required?: boolean
  last?: boolean
  children: ReactNode
}) {
  return (
    // Stacks below `sm`: a fixed 200px caption left a 375px phone ~40px per
    // control, so Name showed two letters and a select only its chevron (EVT-6).
    <FormRow
      labelWidth={200}
      captionClassName="sm:pt-[6px]"
      className="px-[18px] py-[15px]"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
      caption={
        <>
          <label htmlFor={htmlFor} className="text-[13px] font-medium">
            {label}
            {required && <span className="ml-[3px]" style={{ color: 'var(--danger)' }}>*</span>}
          </label>
          {hint && (
            <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
              {hint}
            </div>
          )}
        </>
      }
    >
      {children}
    </FormRow>
  )
}

export function SelectControl({
  id,
  value,
  onChange,
  disabled,
  required,
  maxWidth,
  children,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  required?: boolean
  maxWidth: number
  children: ReactNode
}) {
  return (
    <div className="relative" style={{ maxWidth }}>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        className={SELECT_CLASS}
        style={{ opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2"
        style={{ color: 'var(--fg-subtle)' }}
        size={13}
      />
    </div>
  )
}
