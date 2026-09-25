import type { CSSProperties } from 'react'

/**
 * The form-control boundary: `--input`, pinned by measurement to the 3:1 WCAG
 * 1.4.11 floor for non-text contrast. `--border` is a hairline for row
 * separators (1.20-1.31:1) and left every kit field's edge close to invisible,
 * worst in dark mode (DS-8). The same token `ui/input` and `ui/switch` use, so
 * the two control families now share their edge (DS-9).
 */
export const INPUT_EDGE = '1px solid var(--input)'

/**
 * Corner radius shared with `ui/*` controls (`rounded-md` = --radius). The kit
 * used 7px against ui's 8px, one of the differences that made a settings row
 * and a dialog field look like two design systems (DS-9).
 */
export const INPUT_RADIUS = 'var(--radius)'

// Shared base style for kit text fields. Lives outside kit.tsx because that
// file must export only components (react-refresh/only-export-components);
// sibling controls (e.g. the column-suggest combobox) import it to render
// inputs that match the kit's text fields exactly.
//
// Still the dense settings size (34px / 12.5px) rather than ui/input's
// 36px / 14px: the kit is the compact variant of the same control, not a
// second look for it.
export const INPUT_BASE: CSSProperties = {
  height: 34,
  width: '100%',
  borderRadius: INPUT_RADIUS,
  border: INPUT_EDGE,
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 12.5,
  padding: '0 10px',
}

/**
 * Disabled treatment for every kit text field, textarea and select. Spread
 * after INPUT_BASE (it overrides the same `border` and `background` keys, so
 * no shorthand/longhand collision is introduced).
 *
 * Deliberately a shape change, not an opacity knock-down. The whole cue used
 * to be `opacity: 0.6`, which on the dark theme left a disabled input 3/255 of
 * fill and 7/255 of border away from a live one: Account · Security rendered
 * two dead password boxes indistinguishable from working ones, and the test
 * guarding "nothing here may look actionable" passed because it checked the
 * `disabled` DOM attribute rather than the appearance (tripl-91j6). Losing the
 * darker well and dashing the border reads at a glance at any contrast
 * setting, in either theme, and does not depend on telling two near-blacks
 * apart.
 */
export const INPUT_DISABLED: CSSProperties = {
  background: 'transparent',
  border: '1px dashed var(--border-strong)',
  color: 'var(--fg-subtle)',
  cursor: 'not-allowed',
}
