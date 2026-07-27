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
const AA_LARGE = 3

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
  it.each(THEMES)('$name --accent clears AA-large on --bg', ({ body }) => {
    const ratio = contrastRatio(oklchToken(body, '--accent'), oklchToken(body, '--bg'))
    expect(ratio).toBeGreaterThanOrEqual(AA_LARGE)
  })
})
