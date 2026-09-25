import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useId,
  useRef,
} from 'react'
import { ChevronDown } from 'lucide-react'
import {
  FieldControlIdContext,
  createFieldControlIdSlot,
  useFieldControl,
  useFieldControlId,
} from '@/components/settings/field-control-id'
import {
  INPUT_BASE,
  INPUT_DISABLED,
  INPUT_EDGE,
  INPUT_RADIUS,
} from '@/components/settings/input-style'
import { FormRow } from '@/components/ui/form-row'
import { fieldErrorId } from '@/lib/fieldErrors'
import { PageHeader } from '@/components/primitives/page-header'
import { cn } from '@/lib/utils'

/**
 * Settings control kit — the shared form primitives for the full-takeover
 * Settings area. Recreated in React+TS from the design mockup
 * (design/tripl/project/settings-kit.jsx). These compose raw elements with the
 * project's design tokens (var(--*)) rather than the shadcn UI kit, so the
 * dense, card-driven settings idiom stays self-contained and consistent with
 * the redesigned BranchesTab / ReconciliationPage page style.
 */

// ───────── Page header ─────────
/**
 * The settings pages' header: the shared `PageHeader` with the settings
 * rhythm (a 28px gap before the first card). It used to draw its own 21px
 * title and 13px description while `PageHead` drew 22px / 12px, two
 * "canonical" headers that disagreed (DS-19).
 */
export function SHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return <PageHeader className="mb-7" title={title} description={description} actions={actions} />
}

// ───────── Section card ─────────
export function SCard({
  title,
  description,
  icon,
  children,
  footer,
  tone,
  headingLevel = 2,
}: {
  title?: string
  description?: string
  icon?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  tone?: 'danger'
  /**
   * 2 by default: settings cards are the first level under each settings
   * page's h1. 3 for a card nested under another heading (DS-16).
   */
  headingLevel?: 2 | 3
}) {
  const headingId = useId()
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const borderColor =
    tone === 'danger' ? 'color-mix(in oklab, var(--danger) 40%, var(--border))' : 'var(--border)'
  return (
    <section
      className="mb-5 overflow-hidden rounded-xl"
      style={{ background: 'var(--surface)', border: `1px solid ${borderColor}` }}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || description) && (
        <header
          className="flex items-start gap-[11px] px-[18px] py-4"
          style={{ borderBottom: children ? '1px solid var(--border-subtle)' : 'none' }}
        >
          {icon && (
            <div
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg"
              style={{
                background: tone === 'danger' ? 'var(--danger-soft)' : 'var(--bg-sunken)',
                border: '1px solid var(--border-subtle)',
                color: tone === 'danger' ? 'var(--danger)' : 'var(--fg-muted)',
              }}
            >
              {icon}
            </div>
          )}
          <div className="min-w-0 flex-1">
            {/* h2, not h3, by default: settings cards are the first level
                under each settings page's h1, so h3 made the outline read
                1 → 3 (tripl-jfm3.69). No heading at all for a card with only a
                description — it used to emit an empty <h2> (DS-16). */}
            {title && (
              <Heading
                id={headingId}
                className="m-0 text-[14px] font-semibold"
                style={{ color: tone === 'danger' ? 'var(--danger)' : 'var(--fg)' }}
              >
                {title}
              </Heading>
            )}
            {description && (
              <p
                className="mt-1 text-body-sm leading-[1.5]"
                style={{ color: 'var(--fg-subtle)' }}
              >
                {description}
              </p>
            )}
          </div>
        </header>
      )}
      {children}
      {footer && (
        <footer
          className="flex items-center gap-2.5 px-[18px] py-3"
          style={{
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-sunken)',
          }}
        >
          {footer}
        </footer>
      )}
    </section>
  )
}

// ───────── Field row ─────────

export function Field({
  label,
  labelRight,
  hint,
  children,
  stacked,
  last,
  htmlFor,
  required,
  error,
  errorId: ownErrorId,
  announceError = true,
  labelWidth,
}: {
  label: string
  /** Optional node rendered inline to the right of the label (e.g. a source badge). */
  labelRight?: ReactNode
  hint?: ReactNode
  children: ReactNode
  stacked?: boolean
  last?: boolean
  /**
   * Marks the row required: a visual asterisk beside the label, and
   * `aria-required` on the control the label names — the part a screen reader
   * uses, where a bare red "*" was colour-only and read as "star" (DS-17).
   */
  required?: boolean
  /**
   * The row's validation message. Rendered under the control, announced as it
   * appears, and tied to the control through `aria-describedby` plus
   * `aria-invalid` (DS-17). The five page-level wrappers that grew around this
   * Field to show errors did none of the three.
   */
  error?: ReactNode
  /**
   * The control this row's label names. `false` for a row that holds no
   * labelable control at all — an avatar with two buttons, a role chip — where
   * a generated `htmlFor` can only dangle.
   */
  htmlFor?: string | false
  /**
   * The error message's id, when something else links to it — a form's error
   * summary jumps to `fieldErrorId(control)` (lib/fieldErrors.ts). Generated
   * otherwise.
   */
  errorId?: string
  /**
   * Announce the message as it appears (`role="alert"`). Off in a form whose
   * error summary already announces every problem at once, where one alert
   * per field on top of it is noise.
   */
  announceError?: boolean
  /** The caption column's width from `sm` up, in px (FormRow's default 232). */
  labelWidth?: number
}) {
  const generatedId = useId()
  // The lib/fieldErrors convention when the row names its control, so an error
  // summary can link to `fieldErrorId(control)` without being told the id.
  const errorId = ownErrorId ?? (typeof htmlFor === 'string' ? fieldErrorId(htmlFor) : `${generatedId}-error`)
  const hasError = error !== undefined && error !== null && error !== false && error !== ''
  const controlId = htmlFor === false ? null : (htmlFor ?? generatedId)
  // Fresh per render so the id follows the row's current first control; the
  // slot itself refuses to hand it to a second one (see field-control-id.ts).
  const slot =
    controlId === null
      ? null
      : createFieldControlIdSlot(controlId, {
          describedBy: hasError ? errorId : undefined,
          invalid: hasError || undefined,
          required: required || undefined,
        })
  // The asterisk is the sighted half; `aria-required` on the control is the
  // announced half, so the mark itself stays out of the label's name.
  const requiredMark = required ? (
    <span aria-hidden="true" className="ml-0.5" style={{ color: 'var(--danger)' }}>
      *
    </span>
  ) : null
  const caption = (
    <>
      <div className="flex items-center gap-2">
        {/* The star sits BESIDE the label element, not inside it: inside, it
            became part of the label's text ("Name*"), which is what
            getByLabelText and some screen readers match the control by. */}
        <span className="inline-flex items-baseline">
          {controlId === null ? (
            <span id={generatedId} className="block text-body font-medium" style={{ color: 'var(--fg)' }}>
              {label}
            </span>
          ) : (
            <label htmlFor={controlId} className="block text-body font-medium" style={{ color: 'var(--fg)' }}>
              {label}
            </label>
          )}
          {requiredMark}
        </span>
        {labelRight}
      </div>
      {hint && (
        <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
          {hint}
        </div>
      )}
    </>
  )
  const errorLine = hasError ? (
    <p id={errorId} role={announceError ? 'alert' : undefined} className="mt-1.5 text-[12px] leading-[1.45]" style={{ color: 'var(--danger)' }}>
      {error}
    </p>
  ) : null
  const control = (
    <>
      {slot ? (
        <FieldControlIdContext.Provider value={slot}>{children}</FieldControlIdContext.Provider>
      ) : (
        children
      )}
      {errorLine}
    </>
  )
  // A row with no control is named as a group instead, so the two buttons or
  // the chip inside it are still announced under "Avatar" / "Role".
  const rowProps = {
    role: controlId === null ? 'group' : undefined,
    'aria-labelledby': controlId === null ? generatedId : undefined,
    style: { borderBottom: last ? 'none' : '1px solid var(--border-subtle)' },
  }
  if (stacked) {
    return (
      <div {...rowProps} className="block px-[18px] py-[15px]">
        <div style={{ marginBottom: 9 }}>{caption}</div>
        <div className="min-w-0 flex-1">{control}</div>
      </div>
    )
  }
  // Side-by-side label + control only from `sm` up. The 232px label gutter plus
  // its 24px gap left a phone's control column ~100px wide, so the Name/Slug
  // inputs measured 22px and ran off-screen (tripl-jfm3.40).
  return (
    <FormRow
      {...rowProps}
      caption={caption}
      labelWidth={labelWidth}
      captionClassName="sm:pt-1.5"
      className="px-[18px] py-[15px]"
    >
      {control}
    </FormRow>
  )
}

// ───────── Toggle row ─────────
export function ToggleRow({
  label,
  labelRight,
  hint,
  value,
  onChange,
  last,
  disabled,
}: {
  label: string
  /** Optional node rendered inline to the right of the label (e.g. a source badge). */
  labelRight?: ReactNode
  hint?: ReactNode
  value: boolean
  onChange?: (value: boolean) => void
  last?: boolean
  disabled?: boolean
}) {
  const labelId = useId()
  return (
    <div
      className="flex items-center gap-[18px] px-[18px] py-[14px]"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-body font-medium">
          <span id={labelId}>{label}</span>
          {labelRight}
        </div>
        {hint && (
          <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
            {hint}
          </div>
        )}
      </div>
      <Toggle value={value} onChange={onChange} disabled={disabled} aria-labelledby={labelId} />
    </div>
  )
}

// ───────── Read-only info row ─────────
export function InfoRow({
  label,
  value,
  mono = true,
  last,
}: {
  label: ReactNode
  value: ReactNode
  mono?: boolean
  last?: boolean
}) {
  return (
    // Stacks below `sm` like `Field`: a fixed 200px caption left a phone
    // ~100px for the value, so scan and destination names truncated to a few
    // letters (MON-32). A string value that still truncates carries a `title`.
    <FormRow
      labelWidth={200}
      caption={
        <span className="text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
          {label}
        </span>
      }
      className="gap-1 px-[18px] py-[11px] sm:items-center sm:gap-4"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <span
        className={mono ? 'mono block truncate text-body-sm' : 'block truncate text-body-sm'}
        style={{ color: 'var(--fg)' }}
        title={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined}
      >
        {value}
      </span>
    </FormRow>
  )
}

// ───────── Toggle control ─────────
export function Toggle({
  value,
  onChange,
  disabled,
  'aria-labelledby': ariaLabelledby,
  'aria-label': ariaLabel,
}: {
  value: boolean
  onChange?: (value: boolean) => void
  disabled?: boolean
  'aria-labelledby'?: string
  'aria-label'?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-labelledby={ariaLabelledby}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange?.(!value)}
      className="relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        // Off is `--input`, the 3:1 form-control token ui/switch uses too:
        // --border-strong measured ~1.6:1 (light) and ~1.3:1 (dark) on the
        // card, so an off toggle barely read as a control (DS-8).
        background: value ? 'var(--accent)' : 'var(--input)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span
        className="inline-block h-[16px] w-[16px] rounded-full bg-white transition-transform"
        style={{ transform: value ? 'translateX(16px)' : 'translateX(2px)' }}
      />
    </button>
  )
}

// ───────── Text input ─────────

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  prefix,
  suffix,
  type = 'text',
  disabled,
  id,
  ref,
  required,
  readOnly,
  list,
  autoComplete,
  'aria-label': ariaLabel,
  'aria-required': ariaRequired,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  mono?: boolean
  prefix?: string
  suffix?: string
  type?: 'text' | 'password' | 'number' | 'email'
  disabled?: boolean
  id?: string
  /** React 19 passes `ref` as a prop; forwarded to the <input>. */
  ref?: Ref<HTMLInputElement>
  required?: boolean
  readOnly?: boolean
  /** Id of a <datalist> offering suggestions. */
  list?: string
  autoComplete?: string
  'aria-label'?: string
  'aria-required'?: boolean
  /** Set by a form row that shows a validation message for this control. */
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}) {
  const { id: controlId, aria: fieldAria } = useFieldControl(id)
  const input = (
    <input
      id={controlId}
      ref={ref}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      readOnly={readOnly}
      list={list}
      autoComplete={autoComplete}
      aria-label={ariaLabel}
      aria-required={ariaRequired ?? fieldAria.required}
      aria-invalid={(ariaInvalid ?? fieldAria.invalid) || undefined}
      aria-describedby={ariaDescribedBy ?? fieldAria.describedBy}
      onChange={(e) => onChange?.(e.target.value)}
      className={mono ? 'mono' : undefined}
      style={{
        ...INPUT_BASE,
        // Before the affix branches, not after: INPUT_DISABLED rewrites the
        // whole `border` shorthand and would put back the edge they remove.
        ...(disabled ? INPUT_DISABLED : {}),
        ...(prefix
          ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 'none' }
          : {}),
        ...(suffix
          ? { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: 'none' }
          : {}),
      }}
    />
  )
  if (!prefix && !suffix) return input
  return (
    <div className="flex items-stretch">
      {prefix && (
        <Affix side="left" disabled={disabled}>
          {prefix}
        </Affix>
      )}
      {input}
      {suffix && (
        <Affix side="right" disabled={disabled}>
          {suffix}
        </Affix>
      )}
    </div>
  )
}

function Affix({
  side,
  children,
  disabled,
}: {
  side: 'left' | 'right'
  children: ReactNode
  disabled?: boolean
}) {
  // The affix is glued to the input, so it has to take the same treatment:
  // a live chip welded to a dashed dead box reads as neither.
  const edge = disabled ? '1px dashed var(--border-strong)' : INPUT_EDGE
  return (
    <span
      className="mono flex items-center text-body-sm"
      style={{
        padding: '0 10px',
        color: 'var(--fg-subtle)',
        background: disabled ? 'transparent' : 'var(--bg-sunken)',
        border: edge,
        borderLeft: side === 'left' ? edge : 'none',
        borderRight: side === 'right' ? edge : 'none',
        borderRadius:
          side === 'left' ? `${INPUT_RADIUS} 0 0 ${INPUT_RADIUS}` : `0 ${INPUT_RADIUS} ${INPUT_RADIUS} 0`,
      }}
    >
      {children}
    </span>
  )
}

// ───────── Textarea ─────────
export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  mono,
  disabled,
  id,
  'aria-required': ariaRequired,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
  disabled?: boolean
  id?: string
  'aria-required'?: boolean
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}) {
  const { id: controlId, aria: fieldAria } = useFieldControl(id)
  const props: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    id: controlId,
    rows,
    value,
    placeholder,
    disabled,
    'aria-required': ariaRequired ?? fieldAria.required,
    'aria-invalid': (ariaInvalid ?? fieldAria.invalid) || undefined,
    'aria-describedby': ariaDescribedBy ?? fieldAria.describedBy,
    onChange: (e) => onChange?.(e.target.value),
  }
  return (
    <textarea
      {...props}
      className={mono ? 'mono' : undefined}
      style={{
        width: '100%',
        borderRadius: INPUT_RADIUS,
        border: INPUT_EDGE,
        background: 'var(--bg)',
        color: 'var(--fg)',
        fontSize: 12.5,
        padding: '8px 10px',
        lineHeight: 1.5,
        resize: 'vertical',
        ...(disabled ? INPUT_DISABLED : {}),
      }}
    />
  )
}

// ───────── NativeSelect ─────────
export type SelectOption = string | { value: string; label: string }

/**
 * The kit's native `<select>`. Named for what it is: `ui/select` exports a
 * `Select` too (the Radix listbox), and the shared name invited importing the
 * wrong one (DS-9). Pages use this rather than a raw `<select>` — eslint
 * enforces it for `src/pages/**` (see eslint.config.js).
 */
export function NativeSelect({
  value,
  onChange,
  options,
  disabled,
  id,
  'aria-required': ariaRequired,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: {
  value: string
  onChange?: (value: string) => void
  options: readonly SelectOption[]
  disabled?: boolean
  id?: string
  'aria-required'?: boolean
  'aria-label'?: string
  /** Set by a form row that shows a validation message for this control. */
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}) {
  const { id: controlId, aria: fieldAria } = useFieldControl(id)
  return (
    <div className="relative" style={{ maxWidth: 280 }}>
      <select
        id={controlId}
        value={value}
        disabled={disabled}
        aria-required={ariaRequired ?? fieldAria.required}
        aria-label={ariaLabel}
        aria-invalid={(ariaInvalid ?? fieldAria.invalid) || undefined}
        aria-describedby={ariaDescribedBy ?? fieldAria.describedBy}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full appearance-none"
        style={{
          ...INPUT_BASE,
          paddingRight: 30,
          ...(disabled ? INPUT_DISABLED : {}),
        }}
      >
        {options.map((o) =>
          typeof o === 'string' ? (
            <option key={o} value={o}>
              {o}
            </option>
          ) : (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ),
        )}
      </select>
      {/* A disabled select still shows a chevron, so it gets dimmed to the
          border scale — at hint brightness it kept promising a menu. */}
      <ChevronDown
        className="pointer-events-none absolute right-[11px] top-1/2 h-[13px] w-[13px] -translate-y-1/2"
        style={{ color: disabled ? 'var(--border-strong)' : 'var(--fg-subtle)' }}
      />
    </div>
  )
}


// ───────── Radio cards ─────────
export type RadioCardOption = {
  value: string
  label: string
  description?: string
  icon?: ReactNode
}

export function RadioCards({
  value,
  onChange,
  options,
  columns = 1,
  disabled,
  groupLabel,
}: {
  value: string
  onChange?: (value: string) => void
  options: readonly RadioCardOption[]
  columns?: number
  disabled?: boolean
  /** Accessible name for the radio group (required for WCAG 4.1.2). */
  groupLabel?: string
}) {
  // Adopt the enclosing Field's id too, so its <label htmlFor> resolves to a
  // real element instead of dangling (tripl-5gdg). `groupLabel` still supplies
  // the accessible name — a <label> cannot name a non-labelable element.
  const groupId = useFieldControlId()
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  // One Tab stop for the whole group, on the checked card (or the first), and
  // arrow keys move the choice — the radio-group pattern. Every card used to be
  // its own Tab stop with no arrow-key roving (DS-35).
  const checkedIndex = options.findIndex((o) => o.value === value)
  const tabStop = checkedIndex >= 0 ? checkedIndex : 0
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0 || disabled || options.length === 0) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    const option = options[next]
    if (!option) return
    onChange?.(option.value)
    optionRefs.current[next]?.focus()
  }
  return (
    <div
      id={groupId}
      role="radiogroup"
      aria-label={groupLabel}
      className="grid gap-2"
      // `repeat(N, 1fr)` reads like N equal tracks but is not: 1fr is
      // minmax(auto, 1fr), and that `auto` floor is the item's min-content
      // width. On Plan rules the three Case style cards each kept their longest
      // unbreakable token ("order_completed", "orderCompleted", "Completed") and
      // came out 145 / 141 / 111px inside a 393px control column — 413px of
      // tracks, so the row spilled 19px past the panel padding every other
      // control respects and the third card's right border landed outside the
      // panel entirely (tripl-8fa6). A zero floor makes N siblings render at
      // exactly 1/N and keeps the row inside its column.
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((o, index) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            ref={(el) => {
              optionRefs.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange?.(o.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="flex flex-col gap-0.5 rounded-[9px] px-[13px] py-[11px] text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'var(--accent-soft)' : 'var(--bg)',
            }}
          >
            <span className="flex items-start gap-2.5">
              <span
                className="mt-px flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
                // The ring is the control's indicator, so it answers to the
                // 3:1 form-control token like every other field edge (DS-8).
                style={{
                  border: `1.5px solid ${active ? 'var(--accent)' : 'var(--input)'}`,
                }}
              >
                {active && (
                  <span
                    className="h-[7px] w-[7px] rounded-full"
                    style={{ background: 'var(--accent)' }}
                  />
                )}
              </span>
              <span
                className="flex min-w-0 items-center gap-1.5 text-body-sm font-semibold"
                style={{ color: 'var(--fg)' }}
              >
                {o.icon}
                {o.label}
              </span>
            </span>
            {o.description && (
              // Full card width rather than indented under the label. Equal
              // tracks alone do not make the row readable: at 3 columns in that
              // same 393px column each card is 125px, and the 25px radio gutter
              // took a third of the ~73px left for text — with the examples
              // measuring 87-90px, every card wrapped its example (and
              // "Title Case" wrapped its label too). Given the card's whole
              // ~98px inner width, all three labels and examples fit on one line
              // each, which is also what stops the row growing 48px of dead
              // space under the two that did not wrap.
              <span
                className="block text-caption leading-[1.4]"
                style={{ color: 'var(--fg-subtle)' }}
              >
                {o.description}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ───────── Page header ─────────

/** `PageHeader` under its older kit name; `right` is its `actions` slot (DS-19). */
export function PageHead({
  eyebrow,
  title,
  description,
  right,
}: {
  eyebrow?: string
  title: string
  description?: string
  right?: ReactNode
}) {
  return <PageHeader eyebrow={eyebrow} title={title} description={description} actions={right} />
}

// ───────── Panel ─────────

export type PanelTone = 'warning' | 'danger'
export type PanelSubtitleTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent'

/**
 * Bordered surface card with a header bar (title + optional subtitle + optional
 * right slot). A tone tints the header (danger/warning soft). The one Panel:
 * the local replicas in BranchesTab, ReconciliationPage, EventTypesTab and the
 * scan screens had drifted (radius, padding, and a header that did not wrap on
 * phones) and are gone (DS-15). `className` / `bodyClassName` cover what they
 * customised; a panel with neither title nor right slot drops the header.
 */
export function Panel({
  title,
  subtitle,
  subtitleTone,
  right,
  tone,
  children,
  headingLevel = 2,
  className,
  bodyClassName,
}: {
  title?: string
  subtitle?: ReactNode
  subtitleTone?: PanelSubtitleTone
  right?: ReactNode
  tone?: PanelTone
  children: ReactNode
  /** 2 under a page's h1 (the usual case); 3 when nested under an h2. */
  headingLevel?: 2 | 3
  /** Extra classes on the card (e.g. spacing). */
  className?: string
  /** Extra classes on the scrolling body. */
  bodyClassName?: string
}) {
  const headingId = useId()
  const Heading = headingLevel === 3 ? 'h3' : 'h2'
  const headerBg = tone ? `var(--${tone}-soft)` : 'transparent'
  const titleColor = tone ? `var(--${tone})` : 'var(--fg)'
  const subtitleColor = subtitleTone ? `var(--${subtitleTone})` : 'var(--fg-subtle)'
  return (
    <section
      className={cn('overflow-hidden rounded-card border', className)}
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      aria-labelledby={title ? headingId : undefined}
    >
      {/* The header wraps below `sm`-ish widths instead of pinning the right
          slot: callers hand it fixed-width search boxes and selects, and with a
          `shrink-0` slot the title collapsed to 0px while the last filter was
          sliced off by the section's `overflow-hidden` (tripl-jfm3.43). The
          title keeps a 10rem basis so it never collapses again. */}
      {(title || right) && (
        <header
          className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)', background: headerBg }}
        >
          <div className="min-w-0 flex-1 basis-40">
            {/* A real heading, naming the section: panel pages had nothing
                between the h1 and the content, so heading navigation skipped
                every panel and each <section> was unnamed (DS-16). */}
            {title && (
              <Heading id={headingId} className="m-0 text-body-sm font-semibold" style={{ color: titleColor }}>
                {title}
              </Heading>
            )}
            {subtitle && (
              <div className="mt-0.5 text-2xs" style={{ color: subtitleColor }}>
                {subtitle}
              </div>
            )}
          </div>
          {right && (
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
              {right}
            </div>
          )}
        </header>
      )}
      {/* Scrolls sideways so a wide table is never clipped by the rounded card
          (see .tripl-panel-body in index.css). */}
      <div data-slot="panel-body" className={cn('tripl-scroll-x tripl-panel-body', bodyClassName)}>
        {children}
      </div>
    </section>
  )
}
