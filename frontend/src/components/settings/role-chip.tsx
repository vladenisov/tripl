import { Chip, type ChipTone } from '@/components/primitives/chip'
import { ROLE_OPTIONS, type Role } from '@/types'

/** One tone per role, app-wide: a label maps to exactly one tone (DS-7). */
const ROLE_TONE: Readonly<Record<Role, ChipTone>> = {
  owner: 'accent',
  editor: 'info',
  viewer: 'neutral',
}

/**
 * A member's role as a status pill. Members and Profile used to draw "Owner"
 * two ways — a 10px beige pill on one page, a larger teal one on the other —
 * each hand-rolled (ST-16).
 */
export function RoleChip({
  role,
  size = 'sm',
  className,
}: {
  role: Role
  size?: 'xs' | 'sm' | 'md'
  className?: string
}) {
  const label = ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role
  return (
    <Chip tone={ROLE_TONE[role] ?? 'neutral'} size={size} className={className}>
      {label}
    </Chip>
  )
}
