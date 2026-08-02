/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the WCAG AA floor for the text tokens in `index.css` (tripl-jfm3.44).
 *
 * `--fg-subtle` and `--fg-faint` are not decoration: they carry activity
 * timestamps, chart captions, search placeholders, sidebar section labels and
 * the "—" empty-cell markers, all at 10–12.5px. WCAG 2.x SC 1.4.3 asks for
 * 4.5:1 at those sizes, so the tokens are pinned by measurement rather than by
 * eye. This test reads the real stylesheet, so drifting a token back down
 * fails here instead of on a phone.
 */

const AA_BODY = 4.5

// Surfaces that body copy is actually painted on. `--surface-active` is a
// momentary pressed state that never hosts small text, so it is excluded.
const TEXT_SURFACES = [
  '--bg',
  '--bg-sunken',
  '--bg-elevated',
  '--surface',
  '--surface-hover',
] as const

const BODY_TEXT_TOKENS = ['--fg', '--fg-muted', '--fg-subtle', '--fg-faint'] as const

type Rgb = readonly [number, number, number]

// Read the shipped stylesheet directly: `?raw` goes through the Tailwind
// plugin, which rewrites the file, so the token declarations would be gone.
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'index.css'),
  'utf8',
)

/** Grab the first `<selector> { … }` block body from the stylesheet. */
function block(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block in index.css`)
  const end = css.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${selector} block in index.css`)
  return css.slice(start, end)
}

/** Read `--token: oklch(L C H)` out of a block body. */
function oklchToken(body: string, token: string): Rgb {
  const match = new RegExp(`${token}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(body)
  if (!match) throw new Error(`token ${token} is not a plain oklch() triple`)
  return oklchToSrgb(Number(match[1]), Number(match[2]), Number(match[3]))
}

/** oklch → oklab → linear sRGB → gamma-encoded sRGB (Björn Ottosson's matrices). */
function oklchToSrgb(lightness: number, chroma: number, hueDeg: number): Rgb {
  const hue = (hueDeg * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const encode = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055
  const channels = linear.map((v) => Math.round(Math.min(1, Math.max(0, encode(v))) * 255))
  return [channels[0]!, channels[1]!, channels[2]!] as const
}

/** Read `--token: oklch(L C H / A)` — the translucent tint fills. */
function softToken(body: string, token: string): { rgb: Rgb; alpha: number } {
  const match = new RegExp(
    `${token}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*/\\s*([\\d.]+)\\)`,
  ).exec(body)
  if (!match) throw new Error(`token ${token} is not an oklch() quadruple with alpha`)
  return {
    rgb: oklchToSrgb(Number(match[1]), Number(match[2]), Number(match[3])),
    alpha: Number(match[4]),
  }
}

/**
 * Blend a translucent fill over a base the way a browser does — in gamma-encoded
 * sRGB, NOT in linear light. Getting this wrong is not academic: compositing in
 * linear space reports a fill lighter than the one that actually paints, which
 * hands back a contrast ratio comfortably above the truth (4.59:1 where the
 * browser measures 4.26:1) and lets a failing tint ship as passing.
 */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  const mix = (i: number) => Math.round(fg[i]! * alpha + bg[i]! * (1 - alpha))
  return [mix(0), mix(1), mix(2)] as const
}

function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg)
  const b = relativeLuminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const THEMES = [
  { name: 'light', body: block(':root') },
  { name: 'dark', body: block('.dark') },
] as const

describe.each(THEMES)('$name theme text tokens', ({ body }) => {
  it.each(BODY_TEXT_TOKENS)('%s clears WCAG AA on every text surface', (token) => {
    const fg = oklchToken(body, token)
    for (const surface of TEXT_SURFACES) {
      const ratio = contrastRatio(fg, oklchToken(body, surface))
      expect(
        ratio,
        `${token} on ${surface} measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY)
    }
  })

  it('keeps the prominence order --fg > --fg-muted > --fg-subtle > --fg-faint', () => {
    const surface = oklchToken(body, '--surface')
    const ratios = BODY_TEXT_TOKENS.map((token) => contrastRatio(oklchToken(body, token), surface))
    for (let i = 1; i < ratios.length; i += 1) {
      expect(ratios[i]!, `${BODY_TEXT_TOKENS[i]} must be dimmer than ${BODY_TEXT_TOKENS[i - 1]}`)
        .toBeLessThan(ratios[i - 1]!)
    }
  })
})

describe('identity chip', () => {
  it('carries white initials at AA against --avatar-bg', () => {
    const ratio = contrastRatio([255, 255, 255], oklchToken(block(':root'), '--avatar-bg'))
    expect(ratio, `white on --avatar-bg measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_BODY,
    )
  })
})

describe('accent', () => {
  // AA_BODY, not AA_LARGE: --accent paints 12px inline links, not just large
  // headings. The looser floor is why axe caught a 4.07:1 link while this file
  // stayed green.
  it.each(THEMES)('$name --accent clears AA on --bg', ({ body }) => {
    const ratio = contrastRatio(oklchToken(body, '--accent'), oklchToken(body, '--bg'))
    expect(ratio, `--accent on --bg measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_BODY)
  })
})

/**
 * The tinted-fill floor (the gap that let a whole class of failures through).
 *
 * Everything above models opaque surfaces, but `Chip`, status badges and the
 * demo banners all paint `--<tone>-soft` — a translucent wash — and then put
 * text on top. Those composited fills are where the real failures lived: 16
 * nodes in dark and 33 in light, none of which this file could see.
 */
const TONES = ['--accent', '--success', '--warning', '--danger', '--info'] as const
// Chips sit on plain page background and on cards alike.
const TINT_BASES = ['--bg', '--bg-elevated'] as const

describe.each(THEMES)('$name theme tinted fills', ({ body }) => {
  it.each(TONES)('%s text clears AA on its own soft fill', (tone) => {
    const fg = oklchToken(body, tone)
    const soft = softToken(body, `${tone}-soft`)
    for (const base of TINT_BASES) {
      const fill = composite(soft.rgb, soft.alpha, oklchToken(body, base))
      const ratio = contrastRatio(fg, fill)
      expect(
        ratio,
        `${tone} on ${tone}-soft over ${base} measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY)
    }
  })

  // A tone chip inside a tone-tinted container (a Chip in the demo banner)
  // composites the same wash twice, which is materially darker than one pass.
  it.each(TONES)('%s text survives a doubled tint', (tone) => {
    const fg = oklchToken(body, tone)
    const soft = softToken(body, `${tone}-soft`)
    const once = composite(soft.rgb, soft.alpha, oklchToken(body, '--bg'))
    const twice = composite(soft.rgb, soft.alpha, once)
    const ratio = contrastRatio(fg, twice)
    expect(
      ratio,
      `${tone} on a doubled ${tone}-soft tint measured ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY)
  })

  it.each(TONES)('--fg-muted stays readable on a %s-soft fill', (tone) => {
    const fg = oklchToken(body, '--fg-muted')
    const soft = softToken(body, `${tone}-soft`)
    for (const base of TINT_BASES) {
      const fill = composite(soft.rgb, soft.alpha, oklchToken(body, base))
      const ratio = contrastRatio(fg, fill)
      expect(
        ratio,
        `--fg-muted on ${tone}-soft over ${base} measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY)
    }
  })
})

/**
 * Solid tone buttons. `--danger` and `--accent` flip lightness between themes,
 * so a single fixed foreground cannot clear AA on both — each carries a paired
 * `-fg` token, and the pairing is what this pins.
 */
describe.each(THEMES)('$name theme solid buttons', ({ body }) => {
  it.each([
    ['--accent', '--accent-fg'],
    ['--danger', '--danger-fg'],
  ] as const)('%s carries %s at AA', (surface, foreground) => {
    const ratio = contrastRatio(oklchToken(body, foreground), oklchToken(body, surface))
    expect(
      ratio,
      `${foreground} on ${surface} measured ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY)
  })
})
