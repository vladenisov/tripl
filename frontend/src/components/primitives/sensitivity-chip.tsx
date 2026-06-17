import { SENSITIVITY_OPTIONS, SENSITIVITY_STYLE, type Sensitivity } from '@/types'

export function SensitivityChip({ value }: { value: Sensitivity }) {
  if (!value || value === 'none') {
    return <span className="text-fg-faint text-[10.5px]">—</span>
  }
  const style = SENSITIVITY_STYLE[value]
  const label = SENSITIVITY_OPTIONS.find((o) => o.value === value)?.label ?? value.toUpperCase()
  return (
    <span
      className="inline-flex items-center rounded-full font-semibold leading-none whitespace-nowrap"
      style={{ height: 18, padding: '0 7px', fontSize: 10.5, background: style.bg, color: style.fg }}
    >
      {label}
    </span>
  )
}
