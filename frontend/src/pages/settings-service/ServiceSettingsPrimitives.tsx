import { type ComponentType, type ReactNode } from 'react'
import { CheckCircle2, RotateCcw, XCircle } from 'lucide-react'
import type { SettingSource } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export function SourceBadge({ source }: { source: SettingSource }) {
  return (
    <Badge variant={source === 'override' ? 'info' : 'outline'} className="text-[10px]">
      {source === 'override' ? 'Override' : 'Env'}
    </Badge>
  )
}

export function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={
        active
          ? 'inline-flex items-center gap-1 text-xs text-emerald-600'
          : 'inline-flex items-center gap-1 text-xs text-muted-foreground'
      }
    >
      {active ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

export function SectionCard({
  title,
  icon: Icon,
  children,
  onReset,
  resetting,
}: {
  title: string
  icon: ComponentType<{ className?: string }>
  children: ReactNode
  onReset?: () => void
  resetting?: boolean
}) {
  return (
    <section
      className="mb-5 overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <div
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
      >
        <Icon className="h-4 w-4 text-[color:var(--fg-subtle)]" />
        <h2 className="text-[12.5px] font-semibold">{title}</h2>
        <div className="flex-1" />
        {onReset && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={resetting}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        )}
      </div>
      <div className="grid gap-4 p-4">{children}</div>
    </section>
  )
}

export function FieldRow({
  label,
  source,
  children,
}: {
  label: string
  source?: SettingSource
  children: ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Label className="text-xs">{label}</Label>
        {source && <SourceBadge source={source} />}
      </div>
      {children}
    </div>
  )
}

export function SwitchRow({
  label,
  source,
  checked,
  onChange,
}: {
  label: string
  source?: SettingSource
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <FieldRow label={label} source={source}>
      <div className="flex h-10 items-center">
        <Switch checked={checked} onCheckedChange={onChange} />
      </div>
    </FieldRow>
  )
}

export function SelectRow({
  label,
  source,
  value,
  options,
  onChange,
}: {
  label: string
  source?: SettingSource
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <FieldRow label={label} source={source}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldRow>
  )
}

export function PromptField({
  label,
  source,
  value,
  onChange,
}: {
  label: string
  source?: SettingSource
  value: string
  onChange: (value: string) => void
}) {
  return (
    <FieldRow label={label} source={source}>
      <Textarea
        value={value}
        onChange={event => onChange(event.target.value)}
        rows={4}
        className="min-h-24 font-mono text-xs leading-relaxed"
      />
    </FieldRow>
  )
}
