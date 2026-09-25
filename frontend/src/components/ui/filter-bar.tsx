import * as React from "react"
import { Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/*
 * The one filter-bar idiom for list pages (DS-15): a search box, then filter
 * chips, a "Clear filters" link while anything is set, and the result count
 * on the right. Filters always apply instantly — no Apply button. Segmented
 * controls are for 2-4 exclusive VIEWS, never for filters.
 *
 *   <FilterBar count="42 events" active={hasFilters} onClear={clear}>
 *     <FilterSearch things="events" value={q} onValueChange={setQ} />
 *     <FilterSelect label="Status" value={status} onValueChange={setStatus}
 *       options={[{ value: "live", label: "live" }, ...]} />
 *   </FilterBar>
 */

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"
}

function FilterBar({
  children,
  count,
  active = false,
  onClear,
  className,
}: {
  children: React.ReactNode
  /** Result count, e.g. "42 events"; shown on the right. */
  count?: React.ReactNode
  /** Whether any filter differs from its default; shows "Clear filters". */
  active?: boolean
  onClear?: () => void
  className?: string
}) {
  return (
    <div
      data-slot="filter-bar"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {children}
        {active && onClear && (
          <Button type="button" variant="ghost" size="sm" onClick={onClear} className="text-fg-muted">
            <X aria-hidden="true" />
            Clear filters
          </Button>
        )}
      </div>
      {/* Mounted even while there is no count: a live region inserted
          together with its first text is not announced by most screen
          readers, so the first "N match" would go unread. */}
      <div className="tnum shrink-0 text-caption text-fg-muted" aria-live="polite">
        {count}
      </div>
    </div>
  )
}

/**
 * The bar's search box: 28px like the chips and the sm Clear button, so the
 * row keeps one height; leading icon, "Search {things}…", and "/"
 * focuses it from anywhere outside a text field.
 */
function FilterSearch({
  things,
  value,
  onValueChange,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "ref" | "value" | "onChange" | "placeholder" | "type"> & {
  /** Plural noun for the placeholder and the accessible name: "events". */
  things: string
  value: string
  onValueChange: (value: string) => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.defaultPrevented || isTypingTarget(event.target)) return
      if (!ref.current) return
      event.preventDefault()
      ref.current.focus()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])
  return (
    <div className={cn("relative w-full min-w-[180px] max-w-[320px] flex-1 sm:w-auto", className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-muted"
        aria-hidden="true"
      />
      <Input
        ref={ref}
        type="search"
        aria-label={`Search ${things}`}
        placeholder={`Search ${things}…`}
        value={value}
        onChange={event => onValueChange(event.target.value)}
        className="h-7 pl-8"
        {...props}
      />
    </div>
  )
}

export type FilterOption = { value: string; label: string }

/**
 * One filter as a chip that shows its current value: "Status: any" while
 * unset (dashed, quiet), "Status: live" once set (solid border, accent tint).
 * `anyValue` is the option that means "no filter" (default "any").
 */
function FilterSelect({
  label,
  value,
  onValueChange,
  options,
  anyValue = "any",
  anyLabel = "any",
  className,
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  options: ReadonlyArray<FilterOption>
  anyValue?: string
  anyLabel?: string
  className?: string
}) {
  const set = value !== anyValue
  const current = set ? options.find(option => option.value === value)?.label ?? value : anyLabel
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        // The value belongs in the name: a button-role combobox exposes no
        // separate value, so "Status filter" alone never said what is set.
        aria-label={`${label} filter: ${current}`}
        data-active={set || undefined}
        className={cn(
          "h-7 w-auto gap-1.5 text-caption",
          set
            ? "border-accent bg-accent-soft text-fg"
            : "border-dashed bg-transparent text-fg-muted",
          className
        )}
      >
        <span className="font-medium">{label}:</span>
        <SelectValue>{current}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={anyValue}>{anyLabel}</SelectItem>
        {options
          .filter(option => option.value !== anyValue)
          .map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

export { FilterBar, FilterSearch, FilterSelect }
