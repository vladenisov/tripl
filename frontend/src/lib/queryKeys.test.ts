import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { dataSourcesKey, planBranchesKey } from './queryKeys'

const SRC = join(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry) ? [path] : []
  })
}

describe('shared query keys (tripl-jfm3.115, tripl-jfm3.116)', () => {
  it('spells each family exactly one way', () => {
    expect(dataSourcesKey()).toEqual(['dataSources'])
    expect(planBranchesKey('demo')).toEqual(['planBranches', 'demo'])
  })

  it('is the only place these keys are written', () => {
    // Two spellings of one cache is invisible at runtime — the reader and the
    // writer just stop seeing each other and the screen goes quietly stale. It
    // happened with 'data-sources' vs 'dataSources' across four surfaces, and
    // again with 'plan-branches' vs 'planBranches'. Nothing but a check like
    // this notices the third time.
    const offenders = sourceFiles(SRC)
      .filter((path) => !path.endsWith('queryKeys.ts') && !path.endsWith('queryKeys.test.ts'))
      .filter((path) => {
        const text = readFileSync(path, 'utf8')
        return (
          /\[\s*'data-sources'\s*\]/.test(text)
          || /\[\s*'dataSources'\s*\]/.test(text)
          || /\[\s*'plan-branches'/.test(text)
          || /\[\s*'planBranches'/.test(text)
        )
      })
      .map((path) => path.slice(SRC.length + 1))

    expect(offenders).toEqual([])
  })
})
