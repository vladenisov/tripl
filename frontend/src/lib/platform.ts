const MAC_PATTERN = /Mac|iPhone|iPod|iPad/i

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform || navigator.userAgent || ''
  return MAC_PATTERN.test(platform)
}

// Platform is stable for a session, so resolve once at module load. Safe because
// tripl's frontend is client-only (no SSR/prerender); revisit this memoization if
// server rendering is ever introduced, to avoid a baked-in server value.
const IS_MAC = isMacPlatform()

export function commandPaletteShortcutLabel(): string {
  return IS_MAC ? '⌘K' : 'Ctrl K'
}
