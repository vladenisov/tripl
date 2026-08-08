/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Keeps the published scan docs saying what the Scans surfaces say (tripl-3y7z).
 *
 * The docs are read by a user who is stuck, which is exactly when a sentence
 * that disagrees with the product costs the most: the FAQ used to answer "Do I
 * need to run scans on a schedule to get metrics?" with **No**, while the same
 * file's "No metrics appear after a scan" section, concepts.md, quick-start.md
 * and feature-reference.md all say a schedule is precisely what separates a
 * monitoring scan from a catalog-only one. A user with an empty chart believed
 * the FAQ and went looking for a dead beat container.
 *
 * Nothing but prose ties those surfaces together, so this file ties them to the
 * product itself: the tile names come out of ScansTab.tsx, and the FAQ answer is
 * held to the rule `check_metrics_due` actually applies (it selects only scan
 * configs where BOTH `interval` and `time_column` are set —
 * backend/src/tripl/worker/tasks/metrics/schedule.py).
 */

const SELF = fileURLToPath(import.meta.url)
const SRC = dirname(SELF)
const DOCS = join(resolve(SRC, '../..'), 'website', 'docs')

const readDoc = (relative: string): string => readFileSync(join(DOCS, relative), 'utf8')

/** The four docs a reader treats as one document about scans. */
const SCAN_DOCS = [
  'quick-start.md',
  'use/concepts.md',
  'use/feature-reference.md',
  'use/troubleshooting.md',
]

describe('the scan docs describe the product this branch ships', () => {
  it('feature-reference names the three tiles the Scans page renders', () => {
    const page = readFileSync(join(SRC, 'pages', 'settings', 'ScansTab.tsx'), 'utf8')
    const labels = [...page.matchAll(/<StatCard[\s\S]*?label="([^"]+)"/g)].map((m) => m[1])
    expect(labels, 'ScansTab.tsx should still render exactly three KPI tiles').toHaveLength(3)

    const doc = readDoc('use/feature-reference.md')
    const paragraph = doc
      .split('\n\n')
      .find((block) => block.includes('The scan list heads three figures'))
    expect(
      paragraph,
      'feature-reference.md no longer has the paragraph naming the Scans page tiles, so nothing '
        + 'documents them. Restore it, or update this guard to the sentence that replaced it.',
    ).toBeDefined()

    for (const label of labels) {
      expect(
        paragraph,
        `feature-reference.md names a tile the Scans page does not have: it must say **${label}**, `
          + 'the label ScansTab.tsx renders. A reader who goes looking for the tile the doc names '
          + 'finds a differently-named one.',
      ).toContain(`**${label}**`)
    }
  })

  it('the troubleshooting FAQ does not tell a user a schedule is optional for metric points', () => {
    const doc = readDoc('use/troubleshooting.md')
    const question = '**Do I need to run scans on a schedule to get metrics?**'
    const at = doc.indexOf(question)
    expect(
      at,
      `troubleshooting.md should still carry the FAQ entry ${question} — it is where a user with `
        + 'an empty chart lands.',
    ).toBeGreaterThan(-1)

    const answer = doc.slice(at + question.length).split('\n\n')[0].trim()

    expect(
      answer,
      'The FAQ answers "Do I need to run scans on a schedule to get metrics?" with No, but '
        + 'check_metrics_due only ever dispatches collect_metrics for scans that set BOTH a '
        + 'schedule and a time column, and this same file\'s "No metrics appear after a scan" '
        + 'section, concepts.md, quick-start.md and feature-reference.md all say so. A user reading '
        + 'No concludes the schedule is not the problem and goes hunting for a dead beat container.',
    ).not.toMatch(/^\**No\b/i)

    for (const requirement of [/schedule/i, /time column/i]) {
      expect(
        answer,
        `The FAQ answer must name what the dispatcher requires (${requirement.source}); without `
          + 'both halves it cannot send a Catalog only scan back to the form, which is where the '
          + 'fix is.',
      ).toMatch(requirement)
    }
  })

  it('no scan-facing doc calls a scan a "scan config"', () => {
    // Settled vocabulary: the web UI (and the docs describing it) say "scan".
    // "job" and "scan_config" stay on the wire, so the API/CLI references
    // (run/cli.md, integrate/agent-api-guide.md) are deliberately not in scope,
    // and identifiers like `scan-config-id` or `scan_config_not_dispatchable`
    // are not matched here.
    for (const relative of SCAN_DOCS) {
      const offenders = readDoc(relative)
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /scan configs?\b/i.test(line))
        .map(({ line, number }) => `${relative}:${number}: ${line.trim()}`)

      expect(
        offenders,
        `${relative} calls a scan a "scan config" — the noun the Scans page dropped. Say "scan".`,
      ).toEqual([])
    }
  })
})
