import type { MetaFieldDefinition } from '@/types'

export const META_FIELD_LINK_PLACEHOLDER = '${value}'

/** The example key the form substitutes into a template to show what a value looks like. */
export const META_FIELD_LINK_EXAMPLE_KEY = 'WND-1234'

const ABSOLUTE_URL = /^https?:\/\//i

/**
 * The fixed text a template puts around `${value}`, or null when it has no
 * placeholder — same split as the backend's `strip_link_template`
 * (`services/event_service.py`), on the FIRST placeholder.
 */
function templateAround(template: string): { prefix: string; suffix: string } | null {
  const at = template.indexOf(META_FIELD_LINK_PLACEHOLDER)
  if (at === -1) return null
  return {
    prefix: template.slice(0, at),
    suffix: template.slice(at + META_FIELD_LINK_PLACEHOLDER.length),
  }
}

/**
 * The bare key when `value` is exactly `template` applied to one, else `value`.
 *
 * People paste the whole address out of the browser into a field whose template
 * already IS that address around a key: on production every branch-authored
 * event held `https://jira…/browse/WND-4770` where `WND-4770` was meant, and the
 * rendered link was the template applied to a URL (tripl-kjhi.5). The server
 * strips on write with this same rule; doing it here too means the form shows
 * what will be stored, not what will be corrected. A template with no fixed
 * prefix wraps nothing, so it strips nothing.
 */
export function stripLinkTemplate(template: string | null | undefined, value: string): string {
  const around = template ? templateAround(template) : null
  if (!around || !around.prefix) return value
  const { prefix, suffix } = around
  const text = value.trim()
  if (
    text.startsWith(prefix)
    && text.endsWith(suffix)
    && text.length > prefix.length + suffix.length
  ) {
    return text.slice(prefix.length, text.length - suffix.length)
  }
  return value
}

/**
 * The link a template would render for an example key, or null when the
 * template has no `${value}` to put it in.
 */
export function metaFieldLinkExample(template: string | null | undefined): string | null {
  if (!template || !template.includes(META_FIELD_LINK_PLACEHOLDER)) return null
  return template.replaceAll(META_FIELD_LINK_PLACEHOLDER, META_FIELD_LINK_EXAMPLE_KEY)
}

export function resolveMetaFieldHref(
  metaField: Pick<MetaFieldDefinition, 'field_type' | 'link_template'>,
  value: string,
) {
  if (!value) {
    return null
  }
  if (metaField.link_template) {
    // A value that already is a link — pasted whole, or stored before the
    // server began stripping — must not be wrapped in the template a second
    // time (tripl-kjhi.5).
    if (ABSOLUTE_URL.test(value) || stripLinkTemplate(metaField.link_template, value) !== value) {
      return value
    }
    return metaField.link_template.replaceAll(META_FIELD_LINK_PLACEHOLDER, value)
  }
  if (metaField.field_type === 'url') {
    return value
  }
  return null
}
