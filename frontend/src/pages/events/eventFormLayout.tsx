/**
 * Layout primitives shared by the event authoring pages.
 *
 * Extracted verbatim from `EventForm.tsx`, where they were private, when a
 * second authoring surface appeared: the bulk page must look like the single
 * one, and two copies of a card and a labelled row is how two surfaces that are
 * meant to be the same screen quietly stop being it.
 */
import { useId, type ComponentProps, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { FormRow } from '@/components/ui/form-row'
import { cn } from '@/lib/utils'
import { EvFieldContext, useEvDescribedBy } from './evFieldContext'

// One control style for every section of the form. Details used this class while
// Field values and Meta fields rendered the shared `Input` (a different height
// and border), so one card read as two forms (LIVE-30). `:disabled` also matches
// a control inside a disabled fieldset, which is how the read-only view and the
// locked Event type select now look locked rather than live.
export const EV_INPUT_CLASS =
  'w-full rounded-[7px] border bg-[var(--bg)] px-[11px] text-[13px] text-[var(--fg)] outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:bg-[var(--surface-hover)] disabled:text-[var(--fg-muted)]'
export const SELECT_CLASS = `${EV_INPUT_CLASS} h-[34px] cursor-pointer appearance-none pr-[30px]`
export const TEXT_INPUT_CLASS = `${EV_INPUT_CLASS} h-[34px]`

/**
 * The two widths a control takes on this form. Widths used to be picked per
 * field (Title 340px, Owner 230px, a boolean 160px, Description the whole row)
 * for no reason a reader could see (LIVE-30); now free text takes the row and a
 * choice from a list takes half of a desktop row.
 */
export type EvControlWidth = 'full' | 'half'
export const EV_FULL_WIDTH_CLASS = 'w-full'
export const EV_HALF_WIDTH_CLASS = 'max-w-[240px]'
const HALF_WIDTH_PX = 240

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
  notes,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  required?: boolean
  last?: boolean
  /** Notices under the control (a warning, what saving will do). Rendered
   *  after it and tied to it through `aria-describedby` (EVT-48). */
  notes?: ReactNode
  children: ReactNode
}) {
  const uid = useId()
  const hintId = hint ? `${uid}-hint` : undefined
  const notesId = notes ? `${uid}-notes` : undefined
  const describedBy = [hintId, notesId].filter(Boolean).join(' ') || undefined
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
            {/* The star is decoration; the control itself carries `required`
                or `aria-required`, which is what a screen reader announces
                instead of "star" (EVT-48). */}
            {required && (
              <span className="ml-[3px]" style={{ color: 'var(--danger)' }} aria-hidden="true">*</span>
            )}
          </label>
          {hint && (
            <div id={hintId} className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
              {hint}
            </div>
          )}
        </>
      }
    >
      <EvFieldContext.Provider value={{ describedBy }}>
        {children}
        {notes && <div id={notesId}>{notes}</div>}
      </EvFieldContext.Provider>
    </FormRow>
  )
}

/** A text input in the form's one style, described by its row. */
export function EvInput({
  width = 'full',
  className,
  ...props
}: ComponentProps<'input'> & { width?: EvControlWidth }) {
  const describedBy = useEvDescribedBy(props['aria-describedby'])
  return (
    <input
      {...props}
      aria-describedby={describedBy}
      className={cn(TEXT_INPUT_CLASS, width === 'full' ? EV_FULL_WIDTH_CLASS : EV_HALF_WIDTH_CLASS, className)}
    />
  )
}

/** A textarea in the form's one style, described by its row. */
export function EvTextarea({ className, ...props }: ComponentProps<'textarea'>) {
  const describedBy = useEvDescribedBy(props['aria-describedby'])
  return (
    <textarea
      {...props}
      aria-describedby={describedBy}
      className={cn(EV_INPUT_CLASS, EV_FULL_WIDTH_CLASS, 'min-h-[60px] py-2 leading-[1.5]', className)}
    />
  )
}

export function SelectControl({
  id,
  value,
  onChange,
  disabled,
  required,
  ariaRequired,
  width = 'half',
  children,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  required?: boolean
  /** Announced as required without the browser enforcing it. */
  ariaRequired?: boolean
  width?: EvControlWidth
  children: ReactNode
}) {
  const describedBy = useEvDescribedBy()
  return (
    <div className="relative" style={{ maxWidth: width === 'half' ? HALF_WIDTH_PX : undefined }}>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        aria-required={ariaRequired && !required ? true : undefined}
        aria-describedby={describedBy}
        className={SELECT_CLASS}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2"
        style={{ color: 'var(--fg-subtle)' }}
        size={13}
        aria-hidden="true"
      />
    </div>
  )
}
