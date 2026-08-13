/**
 * Preset mute durations — one definition for every surface that can silence
 * something.
 *
 * Two surfaces mute and they disagreed. `MonitorDetailPage` offered 1h / 24h /
 * 7d on labelled buttons; the incident Inbox hardcoded
 * `Date.now() + 7 * 86_400_000` inside its mutation and put the word "Mute" on
 * an unlabelled button, so an operator could not find out how long they had
 * just snoozed something for — and re-clicking Mute silently extended it
 * another week (tripl-oxkt.7).
 *
 * A preset is a DURATION, never a stored instant: the contract requires
 * `muted_until` to be in the future, so it is rendered into an absolute
 * timestamp at the moment of the click.
 */

/** One offered duration. The label is the duration, so no mute is silent. */
export interface MutePreset {
  label: string
  ms: number
}

const HOUR_MS = 60 * 60 * 1000

export const MUTE_PRESETS: readonly MutePreset[] = [
  { label: '1h', ms: HOUR_MS },
  { label: '24h', ms: 24 * HOUR_MS },
  { label: '7d', ms: 7 * 24 * HOUR_MS },
]

/**
 * The absolute instant a duration resolves to, in the form the API accepts.
 *
 * `now` is injectable so a test can assert the boundary it expects rather than
 * racing the clock.
 */
export function muteUntilIso(durationMs: number, now: number = Date.now()): string {
  return new Date(now + durationMs).toISOString()
}
