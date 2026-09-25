/**
 * Wiring between a settings-style form's field-keyed validation messages and
 * the controls they describe (the metric and fact-table editors). Every message
 * is keyed by the DOM id of its control; the inline message under it (rendered
 * by `FormField`) gets `${id}-error`, and the control points at it. Before this
 * the messages were plain paragraphs no control referenced, so a screen reader
 * heard neither that a field was invalid nor why (MET-15, MET-35).
 */

export type FieldErrors = Readonly<Record<string, string>>

export function fieldErrorId(fieldId: string): string {
  return `${fieldId}-error`
}

/** Props that link a control to its inline message, or nothing when it is valid. */
export function errorAria(
  errors: FieldErrors | undefined,
  fieldId: string,
): { 'aria-invalid'?: boolean; 'aria-describedby'?: string } {
  if (!errors?.[fieldId]) return {}
  return { 'aria-invalid': true, 'aria-describedby': fieldErrorId(fieldId) }
}

const FOCUSABLE = 'input, select, textarea, button, [contenteditable="true"], [tabindex]'

/**
 * Scroll a field into view and move keyboard focus INTO it. The id can sit on
 * a wrapper rather than the control — the SQL editor's id is on the div around
 * CodeMirror, whose focusable surface is an inner contenteditable — so a
 * non-focusable target hands focus to its first focusable descendant; calling
 * `.focus()` on the div itself did nothing and left focus on Save.
 * scrollIntoView is guarded because jsdom does not implement it.
 */
export function focusField(fieldId: string): void {
  const el = document.getElementById(fieldId)
  if (!el) return
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  const target = el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE)
  ;(target ?? el).focus()
}
