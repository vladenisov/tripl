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
 *
 * There are deliberately TWO exported lists. {@link MUTE_PRESETS} is durations
 * only and is what every mute surface maps; {@link INBOX_MUTE_CHOICES} is that
 * list plus the open-ended {@link INDEFINITE_MUTE}, and only the incident Inbox
 * may map it — see the note on `INDEFINITE_MUTE` for why the same button on an
 * alert rule would UNMUTE it (tripl-a50u).
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
 * "Until I unmute" — a mute with no end at all, transmitted as a NULL
 * `muted_until`.
 *
 * A preset above is a DURATION; this is the deliberate ABSENCE of one, which is
 * why it is a separate type with `ms: null` rather than a fourth member of
 * `MUTE_PRESETS` (tripl-a50u). The split is load-bearing, not stylistic:
 *
 *  - On an INCIDENT (`alert_inbox`), `status = 'muted'` with a NULL
 *    `muted_until` is an indefinite mute: `_effective_inbox_status` only lapses
 *    a mute when `muted_until` is set AND has passed, so a NULL one never
 *    lapses and only Unmute lifts it.
 *  - On an ALERT RULE, `is_rule_muted()` returns FALSE the moment `muted_until`
 *    is NULL. The identical button on a rule surface would therefore UN-silence
 *    the rule it promised to silence forever. The permanent lever on a rule is
 *    its enable/disable switch, not a mute.
 *
 * Because `MUTE_PRESETS` is `readonly MutePreset[]` and `ms` there is `number`,
 * appending this to it is a compile error rather than a review comment — the
 * leak cannot be introduced by someone "simplifying" the two lists into one.
 *
 * The wording lives here, once, for the same reason the durations do: two
 * surfaces inventing "Forever" and "Indefinitely" for one idea is exactly the
 * vocabulary drift this module was written to stop (tripl-oxkt.7).
 */
export interface IndefiniteMute {
  label: string
  /** The discriminant AND the wire value: no duration, so no end instant. */
  ms: null
}

/** Either kind of silence a surface can offer — a duration, or no end at all. */
export type MuteChoice = MutePreset | IndefiniteMute

export const INDEFINITE_MUTE: IndefiniteMute = { label: 'Until I unmute', ms: null }

/**
 * What the incident Inbox offers, and the ONLY list that carries the open-ended
 * choice.
 *
 * Named after its surface on purpose: the scope boundary is then a readable
 * line in the shared module instead of a `.filter(…)` incantation that each of
 * the rule surfaces has to remember to repeat (and that a fourth surface added
 * next year would forget). The timed presets stay first, so the riskiest choice
 * is never the leftmost, default-looking button.
 */
export const INBOX_MUTE_CHOICES: readonly MuteChoice[] = [...MUTE_PRESETS, INDEFINITE_MUTE]

/**
 * The absolute instant a duration resolves to, in the form the API accepts.
 *
 * `now` is injectable so a test can assert the boundary it expects rather than
 * racing the clock.
 */
export function muteUntilIso(durationMs: number, now: number = Date.now()): string {
  return new Date(now + durationMs).toISOString()
}

/**
 * The wire value for either kind of choice: an instant, or `null` for "no end".
 *
 * `null` and not `undefined`, and that distinction is the whole reason this
 * lives here rather than being re-derived at each call site: the request body
 * is assembled with an object spread, so an `undefined` would be OMITTED and
 * the most far-reaching mute on the page would post `{action: 'mute'}` with no
 * `muted_until` at all — a different request, meaning "unspecified" rather than
 * "deliberately open-ended" (tripl-a50u).
 */
export function muteChoiceUntilIso(choice: MuteChoice, now: number = Date.now()): string | null {
  return choice.ms === null ? null : muteUntilIso(choice.ms, now)
}
