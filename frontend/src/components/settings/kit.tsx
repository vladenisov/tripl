import {
  type CSSProperties,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
} from 'react'
import { ChevronDown } from 'lucide-react'

/**
 * Settings control kit — the shared form primitives for the full-takeover
 * Settings area. Recreated in React+TS from the design mockup
 * (design/tripl/project/settings-kit.jsx). These compose raw elements with the
 * project's design tokens (var(--*)) rather than the shadcn UI kit, so the
 * dense, card-driven settings idiom stays self-contained and consistent with
 * the redesigned BranchesTab / ReconciliationPage page style.
 */

// ───────── Page header ─────────
export function SHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-7 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-[21px] font-semibold tracking-[-0.015em]">{title}</h1>
        {description && (
          <p
            className="mt-1.5 max-w-[520px] text-[13px] leading-[1.5]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  )
}

// ───────── Section card ─────────
export function SCard({
  title,
  description,
  icon,
  children,
  footer,
  tone,
}: {
  title?: string
  description?: string
  icon?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  tone?: 'danger'
}) {
  const borderColor =
    tone === 'danger' ? 'color-mix(in oklab, var(--danger) 40%, var(--border))' : 'var(--border)'
  return (
    <section
      className="mb-5 overflow-hidden rounded-xl"
      style={{ background: 'var(--surface)', border: `1px solid ${borderColor}` }}
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
            <h3
              className="m-0 text-[14px] font-semibold"
              style={{ color: tone === 'danger' ? 'var(--danger)' : 'var(--fg)' }}
            >
              {title}
            </h3>
            {description && (
              <p
                className="mt-1 text-[12.5px] leading-[1.5]"
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
}: {
  label: string
  /** Optional node rendered inline to the right of the label (e.g. a source badge). */
  labelRight?: ReactNode
  hint?: ReactNode
  children: ReactNode
  stacked?: boolean
  last?: boolean
  htmlFor?: string
}) {
  const generatedId = useId()
  const effectiveFor = htmlFor ?? generatedId
  return (
    <div
      className={stacked ? 'block px-[18px] py-[15px]' : 'flex items-start gap-6 px-[18px] py-[15px]'}
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <div
        className="shrink-0"
        style={{
          width: stacked ? 'auto' : 232,
          marginBottom: stacked ? 9 : 0,
          paddingTop: stacked ? 0 : 6,
        }}
      >
        <div className="flex items-center gap-2">
          <label htmlFor={effectiveFor} className="block text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
            {label}
          </label>
          {labelRight}
        </div>
        {hint && (
          <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
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
        <div className="flex items-center gap-2 text-[13px] font-medium">
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
    <div
      className="flex items-center gap-4 px-[18px] py-[11px]"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <span className="shrink-0 text-[12.5px]" style={{ width: 200, color: 'var(--fg-subtle)' }}>
        {label}
      </span>
      <span
        className={mono ? 'mono min-w-0 flex-1 truncate text-[12.5px]' : 'min-w-0 flex-1 truncate text-[12.5px]'}
        style={{ color: 'var(--fg)' }}
      >
        {value}
      </span>
    </div>
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
        background: value ? 'var(--accent)' : 'var(--border-strong)',
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
const INPUT_BASE: CSSProperties = {
  height: 34,
  width: '100%',
  borderRadius: 7,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 12.5,
  padding: '0 10px',
}

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
  'aria-label': ariaLabel,
  'aria-required': ariaRequired,
}: {
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  mono?: boolean
  prefix?: string
  suffix?: string
  type?: 'text' | 'password' | 'number'
  disabled?: boolean
  id?: string
  'aria-label'?: string
  'aria-required'?: boolean
}) {
  const input = (
    <input
      id={id}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-required={ariaRequired}
      onChange={(e) => onChange?.(e.target.value)}
      className={mono ? 'mono' : undefined}
      style={{
        ...INPUT_BASE,
        ...(prefix
          ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: 'none' }
          : {}),
        ...(suffix
          ? { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRight: 'none' }
          : {}),
        ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
      }}
    />
  )
  if (!prefix && !suffix) return input
  return (
    <div className="flex items-stretch">
      {prefix && <Affix side="left">{prefix}</Affix>}
      {input}
      {suffix && <Affix side="right">{suffix}</Affix>}
    </div>
  )
}

function Affix({ side, children }: { side: 'left' | 'right'; children: ReactNode }) {
  return (
    <span
      className="mono flex items-center text-[12.5px]"
      style={{
        padding: '0 10px',
        color: 'var(--fg-subtle)',
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border)',
        borderLeft: side === 'left' ? '1px solid var(--border)' : 'none',
        borderRight: side === 'right' ? '1px solid var(--border)' : 'none',
        borderRadius: side === 'left' ? '7px 0 0 7px' : '0 7px 7px 0',
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
}: {
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
  disabled?: boolean
  id?: string
  'aria-required'?: boolean
}) {
  const props: TextareaHTMLAttributes<HTMLTextAreaElement> = {
    id,
    rows,
    value,
    placeholder,
    disabled,
    'aria-required': ariaRequired,
    onChange: (e) => onChange?.(e.target.value),
  }
  return (
    <textarea
      {...props}
      className={mono ? 'mono' : undefined}
      style={{
        width: '100%',
        borderRadius: 7,
        border: '1px solid var(--border)',
        background: 'var(--bg)',
        color: 'var(--fg)',
        fontSize: 12.5,
        padding: '8px 10px',
        lineHeight: 1.5,
        resize: 'vertical',
        ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
      }}
    />
  )
}

// ───────── Select ─────────
export type SelectOption = string | { value: string; label: string }

export function Select({
  value,
  onChange,
  options,
  disabled,
  id,
  'aria-required': ariaRequired,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange?: (value: string) => void
  options: readonly SelectOption[]
  disabled?: boolean
  id?: string
  'aria-required'?: boolean
  'aria-label'?: string
}) {
  return (
    <div className="relative" style={{ maxWidth: 280 }}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        aria-required={ariaRequired}
        aria-label={ariaLabel}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full appearance-none"
        style={{
          ...INPUT_BASE,
          paddingRight: 30,
          ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
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
      <ChevronDown
        className="pointer-events-none absolute right-[11px] top-1/2 h-[13px] w-[13px] -translate-y-1/2"
        style={{ color: 'var(--fg-subtle)' }}
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
  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
    >
      {options.map((o) => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange?.(o.value)}
            className="flex items-start gap-2.5 rounded-[9px] px-[13px] py-[11px] text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'var(--accent-soft)' : 'var(--bg)',
            }}
          >
            <span
              className="mt-px flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full"
              style={{ border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}` }}
            >
              {active && (
                <span
                  className="h-[7px] w-[7px] rounded-full"
                  style={{ background: 'var(--accent)' }}
                />
              )}
            </span>
            <span className="min-w-0">
              <span
                className="flex items-center gap-1.5 text-[12.5px] font-semibold"
                style={{ color: 'var(--fg)' }}
              >
                {o.icon}
                {o.label}
              </span>
              {o.description && (
                <span
                  className="mt-0.5 block text-[11.5px] leading-[1.4]"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  {o.description}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ───────── Page header ─────────

/**
 * Page header with an optional uppercase nav-group eyebrow, a 22px title, an
 * optional description, and right-aligned actions. Canonical version of the
 * header used by ReconciliationPage; reuse across redesigned surfaces
 * (Alerting, Overview, Monitors) instead of re-inlining the markup.
 */
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
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            {eyebrow}
          </div>
        )}
        <h1 className={`${eyebrow ? 'mt-1 ' : ''}text-[22px] font-semibold tracking-[-0.01em]`}>
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-[560px] text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            {description}
          </p>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  )
}

// ───────── Panel ─────────

export type PanelTone = 'warning' | 'danger'
export type PanelSubtitleTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent'

/**
 * Bordered surface card with a header bar (title + optional subtitle + optional
 * right slot). A tone tints the header (danger/warning soft). Canonical version
 * of the local Panel replicas in BranchesTab / ReconciliationPage; reuse for
 * Alerting / Overview / Monitors chrome.
 */
export function Panel({
  title,
  subtitle,
  subtitleTone,
  right,
  tone,
  children,
}: {
  title: string
  subtitle?: string
  subtitleTone?: PanelSubtitleTone
  right?: ReactNode
  tone?: PanelTone
  children: ReactNode
}) {
  const headerBg = tone ? `var(--${tone}-soft)` : 'transparent'
  const titleColor = tone ? `var(--${tone})` : 'var(--fg)'
  const subtitleColor = subtitleTone ? `var(--${subtitleTone})` : 'var(--fg-subtle)'
  return (
    <section
      className="overflow-hidden rounded-[10px] border"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <header
        className="flex items-center gap-2.5 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)', background: headerBg }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold" style={{ color: titleColor }}>
            {title}
          </div>
          {subtitle && (
            <div className="mt-0.5 text-[10.5px]" style={{ color: subtitleColor }}>
              {subtitle}
            </div>
          )}
        </div>
        {right && <div className="shrink-0">{right}</div>}
      </header>
      {children}
    </section>
  )
}
