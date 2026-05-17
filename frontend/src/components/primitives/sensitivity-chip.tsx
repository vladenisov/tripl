import { SENSITIVITY_OPTIONS, type Sensitivity } from '@/types'

export function SensitivityChip({ value }: { value: Sensitivity }) {
  const opt = SENSITIVITY_OPTIONS.find((o) => o.value === value) ?? SENSITIVITY_OPTIONS[0]
  if (opt.value === 'none') {
    return <span className="text-muted-foreground text-[10px]">—</span>
  }
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${opt.chip}`}>
      {opt.label}
    </span>
  )
}
