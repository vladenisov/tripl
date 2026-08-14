import { describe, expect, it } from 'vitest'

import {
  INBOX_MUTE_CHOICES,
  INDEFINITE_MUTE,
  MUTE_PRESETS,
  muteChoiceUntilIso,
  muteUntilIso,
} from './mutePresets'

/**
 * The two lists are one module because the WORDING and the wire values must not
 * drift between surfaces (tripl-oxkt.7) — and they are two lists, not one, for a
 * reason the type system enforces and these tests pin behaviourally.
 */
describe('mute presets are durations, and only durations (tripl-a50u)', () => {
  it('holds only finite positive durations, and never the open-ended option', () => {
    // All three mute surfaces map MUTE_PRESETS. Folding the open-ended choice
    // into it — the obvious "simplification" — grows a button on the two RULE
    // surfaces that posts a NULL `muted_until`, which `is_rule_muted()` reads
    // as NOT MUTED: a control labelled "until I unmute" that unmutes the rule.
    expect(MUTE_PRESETS.length).toBeGreaterThan(0)
    for (const preset of MUTE_PRESETS) {
      expect(typeof preset.ms).toBe('number')
      expect(Number.isFinite(preset.ms)).toBe(true)
      expect(preset.ms).toBeGreaterThan(0)
      expect(preset.label).not.toBe(INDEFINITE_MUTE.label)
    }
  })

  it('offers the inbox the timed presets plus exactly one open-ended choice', () => {
    // Order matters as much as membership: the timed presets stay first so the
    // riskiest choice is never the leftmost, default-looking button.
    expect(INBOX_MUTE_CHOICES).toHaveLength(MUTE_PRESETS.length + 1)
    expect(INBOX_MUTE_CHOICES.slice(0, MUTE_PRESETS.length)).toEqual([...MUTE_PRESETS])
    expect(INBOX_MUTE_CHOICES.filter(choice => choice.ms === null)).toEqual([INDEFINITE_MUTE])
  })

  it('words the open-ended option once, here', () => {
    // A second surface inventing "Forever" or "Indefinitely" is the
    // two-vocabularies-for-one-idea drift this module exists to stop.
    expect(INDEFINITE_MUTE.label).toBe('Until I unmute')
  })
})

describe('a choice resolves to what goes on the wire', () => {
  it('renders a duration against the injected clock', () => {
    // Injectable `now`, so this asserts a boundary rather than racing the wall
    // clock — and so a re-hand-rolled local resolver cannot quietly return a
    // different instant for the same preset.
    const now = Date.parse('2026-08-14T10:00:00Z')
    expect(muteChoiceUntilIso({ label: '1h', ms: 3_600_000 }, now)).toBe('2026-08-14T11:00:00.000Z')
    expect(muteChoiceUntilIso(MUTE_PRESETS[0], now)).toBe(muteUntilIso(MUTE_PRESETS[0].ms, now))
  })

  it('resolves the open-ended choice to null, strictly — never undefined', () => {
    // `undefined` would be OMITTED by the object spread that assembles the
    // request body, so the mute would post `{action: 'mute'}` with no
    // `muted_until` at all: a different request meaning "unspecified" rather
    // than "deliberately open-ended".
    const resolved = muteChoiceUntilIso(INDEFINITE_MUTE, Date.parse('2026-08-14T10:00:00Z'))
    expect(resolved).toBeNull()
    expect(resolved).not.toBeUndefined()
  })
})
