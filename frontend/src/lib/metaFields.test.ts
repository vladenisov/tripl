import { describe, expect, it } from 'vitest'
import { metaFieldLinkExample, resolveMetaFieldHref, stripLinkTemplate } from './metaFields'

const TEMPLATE = 'https://tracker.example.com/issues/${value}'

describe('resolveMetaFieldHref', () => {
  it('builds link from template while keeping stored value separate', () => {
    expect(resolveMetaFieldHref(
      { field_type: 'string', link_template: TEMPLATE },
      'TASK-123',
    )).toBe('https://tracker.example.com/issues/TASK-123')
  })

  it('falls back to raw url values for url fields without template', () => {
    expect(resolveMetaFieldHref(
      { field_type: 'url', link_template: null },
      'https://example.com/task/42',
    )).toBe('https://example.com/task/42')
  })

  it('returns null for empty values', () => {
    expect(resolveMetaFieldHref(
      { field_type: 'string', link_template: 'https://example.com/${value}' },
      '',
    )).toBeNull()
  })

  it('does not wrap a value that already is the template applied to a key', () => {
    // What production held for every branch-authored event: the whole address
    // pasted where the key was meant. Rendering must not double it
    // (tripl-kjhi.5).
    expect(resolveMetaFieldHref(
      { field_type: 'string', link_template: TEMPLATE },
      'https://tracker.example.com/issues/TASK-123',
    )).toBe('https://tracker.example.com/issues/TASK-123')
  })

  it('leaves any absolute URL alone, even one the template did not produce', () => {
    expect(resolveMetaFieldHref(
      { field_type: 'string', link_template: TEMPLATE },
      'https://other.example.org/x/1',
    )).toBe('https://other.example.org/x/1')
  })
})

describe('stripLinkTemplate', () => {
  it('returns the bare key when the value is the template around one', () => {
    expect(stripLinkTemplate(TEMPLATE, 'https://tracker.example.com/issues/TASK-123'))
      .toBe('TASK-123')
    // Pasted with the whitespace a browser's address bar gives away.
    expect(stripLinkTemplate(TEMPLATE, '  https://tracker.example.com/issues/TASK-123\n'))
      .toBe('TASK-123')
  })

  it('honours a suffix after the placeholder', () => {
    expect(stripLinkTemplate('https://x.example/${value}/view', 'https://x.example/ABC-1/view'))
      .toBe('ABC-1')
  })

  it('leaves a bare key, an unrelated URL, and an empty remainder as they are', () => {
    expect(stripLinkTemplate(TEMPLATE, 'TASK-123')).toBe('TASK-123')
    expect(stripLinkTemplate(TEMPLATE, 'https://other.example.org/TASK-123'))
      .toBe('https://other.example.org/TASK-123')
    // The template applied to nothing is not a key.
    expect(stripLinkTemplate(TEMPLATE, 'https://tracker.example.com/issues/'))
      .toBe('https://tracker.example.com/issues/')
  })

  it('strips nothing without a placeholder, a prefix, or a template at all', () => {
    expect(stripLinkTemplate('https://tracker.example.com/issues/', 'anything')).toBe('anything')
    // No fixed text before the key means nothing wraps it — the backend's rule.
    expect(stripLinkTemplate('${value}/view', 'ABC-1/view')).toBe('ABC-1/view')
    expect(stripLinkTemplate(null, 'ABC-1')).toBe('ABC-1')
  })
})

describe('metaFieldLinkExample', () => {
  it('shows what the template makes of an example key', () => {
    expect(metaFieldLinkExample(TEMPLATE)).toBe('https://tracker.example.com/issues/WND-1234')
  })

  it('has no example for a template with nowhere to put the key', () => {
    expect(metaFieldLinkExample('https://tracker.example.com/issues/')).toBeNull()
    expect(metaFieldLinkExample(null)).toBeNull()
  })
})
