/**
 * Below md the events table stops being a 17-column strip a phone scrolls
 * sideways through behind a pinned name: every row becomes a card — handle,
 * checkbox and event name on the first line, type / status / signal / 48h
 * volume / tags wrapping under it (DS-5, LIVE-15).
 *
 * All of it is `max-md:` classes, so nothing changes from md up and the row
 * keeps one DOM (and one measured height for the virtualizer, which sizes rows
 * with `measureElement`). Several carry `!`: the `.tripl-table` rules in
 * index.css are unlayered, so they beat plain Tailwind utilities.
 */

/** On the `<table>`: block layout, so rows can be flex cards. */
export const PHONE_TABLE = 'max-md:block max-md:[&>thead]:block max-md:[&>tbody]:block'

/**
 * On the header row: only the reorder spacer and the pinned cells (select-all
 * and "Event") stay; the column headers and their filters have no column to
 * sit over in a card. The empty reorder header stays so select-all lines up
 * over the row checkboxes, which sit after each card's 32px drag handle; the
 * gap and padding match PHONE_ROW for the same reason.
 */
export const PHONE_HEADER_ROW =
  'max-md:flex max-md:items-center max-md:gap-x-2 max-md:px-2 max-md:py-2 '
  + 'max-md:[&>th]:static! max-md:[&>th]:p-0! '
  + 'max-md:[&>th:not(.tripl-pin-l):not(:first-child)]:hidden '
  // No bordered "EVENT" box and orphan rule over the cards: the bar is the
  // select-all checkbox alone (EV-28).
  + 'max-md:[&>th]:border-0! max-md:[&>th[data-pinned=true]]:hidden'

/** On each event row. */
export const PHONE_ROW =
  'max-md:flex max-md:h-auto! max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1.5 '
  + 'max-md:border-b max-md:px-2 max-md:py-2.5 '
  + 'max-md:[&>td]:static! max-md:[&>td]:border-0! max-md:[&>td]:p-0! '
  // The pinned cells keep their opaque sticky fill on desktop; inside a card
  // it painted darker boxes behind the checkbox and name (EV-28).
  + 'max-md:[&>td.tripl-pin-l]:bg-transparent! '
  // index.css skips painting off-screen rows at the desktop `--row-h`; a card
  // skipped that way measures a desktop row tall until it is painted.
  + 'max-md:[content-visibility:visible]! max-md:[contain-intrinsic-size:none]!'

/**
 * On the event-name cell: it takes the rest of the first line (handle and
 * checkbox are 32px + 40px), which is what pushes every later cell onto the
 * next one.
 */
export const PHONE_NAME_CELL = 'max-md:min-w-0 max-md:flex-1 max-md:basis-[calc(100%-6rem)]'

/** On the name cell's content box, whose inline max-width is a desktop cap. */
export const PHONE_NAME_CONTENT = 'max-md:max-w-none!'

/**
 * Columns a card does without: they read only under a column header (reviewed,
 * last seen, owner, custom field and meta values). Δ 24h stays, beside the
 * count (EV-28).
 */
export const PHONE_DROPPED_CELL = 'max-md:hidden'

/**
 * A full-width row that is not an event (loading, empty state). `h-auto!`: the
 * block row kept the desktop `--row-h` from index.css, and the card's
 * `overflow-hidden` clipped "No events yet" to a 28px strip (EV-17).
 */
export const PHONE_FULL_ROW = 'max-md:block max-md:h-auto! max-md:[&>td]:block'

/** The viewport the `max-md:` classes above apply to (Tailwind's md is 48rem). */
export const PHONE_CARD_QUERY = '(max-width: 47.99rem)'

/**
 * What an unrendered phone card is assumed to measure: two to three lines
 * (name, then the chips) plus 20px of padding. Rows are measured once
 * rendered; this only sizes the placeholders the scroll spacer is built from,
 * which at the desktop row height left the spacer a third of its real length
 * and the scroll thumb jumping as pages loaded.
 */
export const PHONE_CARD_HEIGHT_ESTIMATE = 76
