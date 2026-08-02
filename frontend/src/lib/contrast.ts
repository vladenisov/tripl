/**
 * Pick a legible text colour for an arbitrary background.
 *
 * Event-type colours come from a free `<input type="color">`, so no palette can
 * be pre-vetted — a fixed white label reads at 2.14:1 on amber and 2.27:1 on
 * green. Choosing whichever of black/white contrasts better is not a heuristic:
 * the two curves cross at a background luminance of ~0.179, where both measure
 * 4.58:1, so the better of the pair always clears the 4.5:1 AA floor whatever
 * colour someone picks.
 */

const WHITE = '#ffffff'
const BLACK = '#000000'

/** Parse `#rgb` / `#rrggbb` into 0-255 channels. Anything else → null. */
function parseHex(color: string): [number, number, number] | null {
  const hex = color.trim().replace(/^#/, '')
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Black or white — whichever is more legible on `background`. */
export function readableTextOn(background: string | null | undefined): string {
  const rgb = background ? parseHex(background) : null
  // Unparseable colours (named, rgb(), a CSS variable) are left to the caller's
  // own styling rather than guessed at; white matches the previous behaviour.
  if (!rgb) return WHITE
  const luminance = relativeLuminance(rgb)
  const onWhite = 1.05 / (luminance + 0.05)
  const onBlack = (luminance + 0.05) / 0.05
  return onBlack >= onWhite ? BLACK : WHITE
}
