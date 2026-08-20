import type { CSSProperties } from 'react'

// Shared base style for kit text fields. Lives outside kit.tsx because that
// file must export only components (react-refresh/only-export-components);
// sibling controls (e.g. the column-suggest combobox) import it to render
// inputs that match the kit's text fields exactly.
export const INPUT_BASE: CSSProperties = {
  height: 34,
  width: '100%',
  borderRadius: 7,
  border: '1px solid var(--border)',
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
