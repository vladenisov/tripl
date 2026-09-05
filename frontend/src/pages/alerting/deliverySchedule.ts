/**
 * The delivery cadence of an alert destination, as the form sees it.
 *
 * The wire format is a single 5-field cron string (or null for "immediate"),
 * because one encoding in the database means one parser in the worker. The
 * presets below are a UI affordance over that string: picking "Daily" and a
 * time writes `0 9 * * *`, and reading `0 9 * * *` back selects "Daily" at
 * 09:00. Anything the presets cannot express round-trips through the Custom
 * mode unchanged, so a hand-written cron is never silently rewritten.
 */

export type CadenceMode = 'immediate' | 'hourly' | 'daily' | 'times_of_day' | 'weekly' | 'custom'

export interface CadenceDraft {
  mode: CadenceMode
  /** "HH:MM" for daily/weekly. */
  time: string
  /** Comma-separated "HH:MM" list for times_of_day. */
  times: string
  /** 0 = Sunday .. 6 = Saturday, for weekly. */
  weekday: number
  /** The raw expression, authoritative in custom mode. */
  cron: string
}

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export const CADENCE_OPTIONS: { value: CadenceMode; label: string; hint: string }[] = [
  {
    value: 'immediate',
    label: 'Immediately',
    hint: 'Send as soon as a collection finds something. This is the default.',
  },
  { value: 'hourly', label: 'Hourly', hint: 'One message per hour, on the hour.' },
  { value: 'daily', label: 'Daily', hint: 'One message a day, at the time you choose.' },
  {
    value: 'times_of_day',
    label: 'Several times a day',
    hint: 'One message at each time you list.',
  },
  { value: 'weekly', label: 'Weekly', hint: 'One message a week.' },
  { value: 'custom', label: 'Custom (cron)', hint: 'A 5-field cron expression.' },
]

export const DEFAULT_CADENCE: CadenceDraft = {
  mode: 'immediate',
  time: '09:00',
  times: '09:00, 18:00',
  weekday: 1,
  cron: '',
}

const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = TIME_PATTERN.exec(value.trim())
  if (!match) return null
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** The cron expression a draft means, or null for "immediate". */
export function cadenceToCron(draft: CadenceDraft): string | null {
  switch (draft.mode) {
    case 'immediate':
      return null
    case 'hourly':
      return '0 * * * *'
    case 'daily': {
      const at = parseTime(draft.time)
      return at ? `${at.minute} ${at.hour} * * *` : null
    }
    case 'times_of_day': {
      const parsed = draft.times
        .split(',')
        .map(part => parseTime(part))
        .filter((at): at is { hour: number; minute: number } => at !== null)
      if (parsed.length === 0) return null
      // Cron cannot express "09:00 and 18:30" as one expression when the
      // minutes differ, so the shared-minute case is the one the preset
      // covers; anything else falls back to the union of minutes and hours,
      // which the description below states plainly rather than hiding.
      const minutes = [...new Set(parsed.map(at => at.minute))].sort((a, b) => a - b)
      const hours = [...new Set(parsed.map(at => at.hour))].sort((a, b) => a - b)
      return `${minutes.join(',')} ${hours.join(',')} * * *`
    }
    case 'weekly': {
      const at = parseTime(draft.time)
      return at ? `${at.minute} ${at.hour} * * ${draft.weekday}` : null
    }
    case 'custom': {
      const cleaned = draft.cron.trim().replace(/\s+/g, ' ')
      return cleaned === '' ? null : cleaned
    }
  }
}

/** The draft that best represents a stored expression. */
export function cronToCadence(cron: string | null | undefined): CadenceDraft {
  if (!cron || cron.trim() === '') return { ...DEFAULT_CADENCE }
  const cleaned = cron.trim().replace(/\s+/g, ' ')
  const fields = cleaned.split(' ')
  const base: CadenceDraft = { ...DEFAULT_CADENCE, mode: 'custom', cron: cleaned }
  if (fields.length !== 5) return base

  const [minute, hour, dom, month, dow] = fields
  const everyDay = dom === '*' && month === '*'
  const isNumber = (value: string) => /^\d+$/.test(value)
  const isNumberList = (value: string) => /^\d+(,\d+)*$/.test(value)

  if (everyDay && dow === '*' && minute === '0' && hour === '*') {
    return { ...base, mode: 'hourly' }
  }
  if (everyDay && dow === '*' && isNumber(minute) && isNumber(hour)) {
    return { ...base, mode: 'daily', time: formatTime(Number(hour), Number(minute)) }
  }
  if (everyDay && dow === '*' && isNumber(minute) && isNumberList(hour) && hour.includes(',')) {
    const times = hour
      .split(',')
      .map(part => formatTime(Number(part), Number(minute)))
      .join(', ')
    return { ...base, mode: 'times_of_day', times }
  }
  if (everyDay && isNumber(dow) && isNumber(minute) && isNumber(hour)) {
    return {
      ...base,
      mode: 'weekly',
      time: formatTime(Number(hour), Number(minute)),
      weekday: Number(dow) % 7,
    }
  }
  return base
}

/** A one-line description of a cron expression, for the card and the form. */
export function describeCron(cron: string | null | undefined): string {
  if (!cron || cron.trim() === '') return 'Immediately, after every collection'
  const draft = cronToCadence(cron)
  switch (draft.mode) {
    case 'hourly':
      return 'Hourly, on the hour'
    case 'daily':
      return `Daily at ${draft.time}`
    case 'times_of_day':
      return `Every day at ${draft.times}`
    case 'weekly':
      return `Every ${WEEKDAY_LABELS[draft.weekday]} at ${draft.time}`
    default:
      return `Custom schedule (${cron.trim()})`
  }
}

/**
 * Why this draft cannot be saved, or null when it can.
 *
 * Client-side only, and deliberately narrow: the backend validates the cron
 * itself and owns the final word. This exists so the common typo is caught
 * before a round trip, not to reimplement the parser.
 */
export function validateCadence(draft: CadenceDraft): string | null {
  switch (draft.mode) {
    case 'daily':
    case 'weekly':
      return parseTime(draft.time) ? null : 'Enter a time as HH:MM, for example 09:00.'
    case 'times_of_day': {
      const parts = draft.times.split(',').map(part => part.trim()).filter(Boolean)
      if (parts.length === 0) return 'List at least one time, for example 09:00, 18:00.'
      return parts.every(part => parseTime(part))
        ? null
        : 'Enter each time as HH:MM, separated by commas.'
    }
    case 'custom': {
      const cleaned = draft.cron.trim().replace(/\s+/g, ' ')
      if (cleaned === '') return 'Enter a cron expression, or choose another cadence.'
      return cleaned.split(' ').length === 5
        ? null
        : 'A cron expression has 5 fields: minute hour day-of-month month day-of-week.'
    }
    default:
      return null
  }
}
