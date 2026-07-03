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
