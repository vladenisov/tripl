/**
 * The history's `field` as a person reads it. The backend records the tags,
 * each field value and each meta value under their own keys since tripl-kjhi.9
 * (`tags`, `field:<name>`, `meta:<name>`) and a `created` row first.
 */
export function historyFieldLabel(field: string): string {
  if (field === 'created') return 'Created'
  if (field === 'tags') return 'Tags'
  if (field === 'title') return 'Title'
  if (field === 'sunset_at') return 'Sunset'
  if (field.startsWith('field:')) return `Field · ${field.slice('field:'.length)}`
  if (field.startsWith('meta:')) return field.slice('meta:'.length)
  return field
}
