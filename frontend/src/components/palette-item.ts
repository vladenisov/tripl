// One row style for both palettes (command-palette-dialog, settings-palette).
// cmdk keeps DOM focus in the search input and marks the active row with
// `aria-selected`, so the browser's :focus-visible outline never reaches the
// row: arrowing through the list moved only a faint surface-hover fill. The
// row now also carries the focus ring (`--ring`, 2px, the same colour and
// weight as the global :focus-visible outline), inset so the list's scroll
// box does not clip it.
export const PALETTE_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-body-sm text-fg aria-selected:bg-surface-hover aria-selected:ring-2 aria-selected:ring-inset aria-selected:ring-ring'
