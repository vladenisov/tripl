/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the WCAG AA floor for the text tokens in `index.css` (tripl-jfm3.44,
 * extended to the status tones by tripl-zgtu).
 *
 * `--fg-subtle` and `--fg-faint` are not decoration: they carry activity
 * timestamps, chart captions, search placeholders, sidebar section labels and
 * the "—" empty-cell markers, all at 10–12.5px. WCAG 2.x SC 1.4.3 asks for
 * 4.5:1 at those sizes, so the tokens are pinned by measurement rather than by
 * eye. This test reads the real stylesheet, so drifting a token back down
 * fails here instead of on a phone.
 *
 * The status tones are held to the same bar in the hardest place they appear:
 * `--<tone>` as text on its own `--<tone>-soft` fill. That pairing IS the
 * status-chip vocabulary (Chip, Dot, Badge, and every `bg-*-soft text-*` call
 * site), and tinting a surface with the same hue as the text is what eats the
 * ratio, so it is the case worth pinning.
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

// Every tone that carries status *text*. `--<tone>` is the ink, `--<tone>-soft`
// the fill it sits on. `--accent` is deliberately absent: it is the
// user-switchable brand hue (five `.accent-*` variants), it is painted as a
// solid with `--accent-fg` on top rather than as status text, and it is
// measured separately below. Raising it to this bar is tripl-yx0k.
const STATUS_TONES = ['success', 'warning', 'danger', 'info'] as const

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

type Oklch = { lightness: number; chroma: number; hueDeg: number; alpha: number }

/** Read `--token: oklch(L C H)` — or `oklch(L C H / A)` — out of a block body. */
function oklchDecl(body: string, token: string): Oklch {
  const match = new RegExp(
    `${token}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*/\\s*([\\d.]+))?\\)`,
  ).exec(body)
  if (!match) throw new Error(`token ${token} is not a plain oklch() declaration`)
  return {
    lightness: Number(match[1]),
    chroma: Number(match[2]),
    hueDeg: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  }
}

/** The opaque sRGB color of a token, ignoring any alpha it carries. */
function oklchToken(body: string, token: string): Rgb {
  const { lightness, chroma, hueDeg } = oklchDecl(body, token)
  return oklchToSrgb(lightness, chroma, hueDeg)
}

/** oklch → oklab → linear sRGB (Björn Ottosson's matrices), before any clamp. */
function oklchToLinearRgb(lightness: number, chroma: number, hueDeg: number): number[] {
  const hue = (hueDeg * Math.PI) / 180
  const a = chroma * Math.cos(hue)
  const b = chroma * Math.sin(hue)
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/** …then gamma-encoded and clamped into 8-bit sRGB. */
function oklchToSrgb(lightness: number, chroma: number, hueDeg: number): Rgb {
  const encode = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055
  const channels = oklchToLinearRgb(lightness, chroma, hueDeg).map((v) =>
    Math.round(Math.min(1, Math.max(0, encode(v))) * 255),
  )
  return [channels[0]!, channels[1]!, channels[2]!] as const
}

/**
 * Whether a declaration lands inside sRGB. Outside it the browser gamut-maps
 * (chroma reduction against ΔE-OK), which this file's clamp does not model — so
 * a ratio measured here for an out-of-gamut color is not the painted one.
 */
function isInSrgbGamut({ lightness, chroma, hueDeg }: Oklch): boolean {
  return oklchToLinearRgb(lightness, chroma, hueDeg).every((v) => v >= -0.0005 && v <= 1.0005)
}

/**
 * Source-over compositing of a translucent fill onto an opaque surface.
 *
 * In gamma-encoded sRGB, not linear-light: painting a translucent background
 * over an opaque backdrop happens in the backdrop's color space (linear-light
 * is for `mix-blend-mode` and filters). Verified against painted pixels rather
 * than read off the spec — screenshotting these exact pairs in Chromium and
 * predicting them both ways gives a total absolute channel error, over 20
 * samples per theme, of 28 (light) / 13 (dark) for the model below against
 * 608 / 1666 for linear-light. The first is rounding; the second is a
 * different color.
 */
function composite(fill: Oklch, surface: Rgb): Rgb {
  const rgb = oklchToSrgb(fill.lightness, fill.chroma, fill.hueDeg)
  const mix = (i: number) => Math.round(fill.alpha * rgb[i]! + (1 - fill.alpha) * surface[i]!)
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

describe.each(THEMES)('$name theme status tones', ({ body }) => {
  it.each(STATUS_TONES)(
    '--%s clears WCAG AA as text on its own soft fill',
    (tone) => {
      const ink = oklchToken(body, `--${tone}`)
      const fill = oklchDecl(body, `--${tone}-soft`)
      for (const surface of TEXT_SURFACES) {
        const ratio = contrastRatio(ink, composite(fill, oklchToken(body, surface)))
        expect(
          ratio,
          `--${tone} on --${tone}-soft over ${surface} measured ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(AA_BODY)
      }
    },
  )

  // The same ink without the fill: `text-warning` on a plain row is as common
  // as the chip, and the fill is not what rescues it.
  it.each(STATUS_TONES)('--%s clears WCAG AA on an untinted surface', (tone) => {
    const ink = oklchToken(body, `--${tone}`)
    for (const surface of TEXT_SURFACES) {
      const ratio = contrastRatio(ink, oklchToken(body, surface))
      expect(
        ratio,
        `--${tone} on ${surface} measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY)
    }
  })

  // Guards the measurement itself rather than the design: see isInSrgbGamut.
  it.each(STATUS_TONES)('--%s and its soft fill stay inside sRGB', (tone) => {
    for (const token of [`--${tone}`, `--${tone}-soft`]) {
      expect(isInSrgbGamut(oklchDecl(body, token)), `${token} is outside sRGB`).toBe(true)
    }
  })
})

/**
 * The destructive button is the one place a tone is painted as a SOLID fill
 * with a label on top, so it needs a foreground that flips with the theme —
 * `--danger` itself cannot move, being pinned above as status ink on its own
 * soft fill. Hover is measured too: `hover:bg-destructive/90` lets the surface
 * through, which moves the fill toward the background.
 */
describe('destructive button', () => {
  it('aliases --destructive to --danger, which is what the cases below measure', () => {
    expect(block(':root')).toMatch(/--destructive:\s*var\(--danger\)/)
  })

  it.each(THEMES)('$name label clears WCAG AA on the fill and on hover', ({ name, body }) => {
    // The foreground is declared per theme and inherited from :root otherwise.
    const declaredIn = /--destructive-foreground:/.test(body) ? body : block(':root')
    const ink = oklchToken(declaredIn, '--destructive-foreground')
    const fill = oklchDecl(body, '--danger')

    const onFill = contrastRatio(ink, oklchToSrgb(fill.lightness, fill.chroma, fill.hueDeg))
    expect(onFill, `${name} label on --destructive measured ${onFill.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(AA_BODY)

    for (const surface of TEXT_SURFACES) {
      const hovered = composite({ ...fill, alpha: 0.9 }, oklchToken(body, surface))
      const ratio = contrastRatio(ink, hovered)
      expect(
        ratio,
        `${name} label on hover:bg-destructive/90 over ${surface} measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY)
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
