import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { dataSourcesKey, planBranchesKey, variablesKey, variablesPageKey } from './queryKeys'

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
    expect(variablesKey('demo', 'branch-1')).toEqual(['variables', 'demo', 'branch-1'])
  })

  it('keeps the two variable shapes in separate caches, page nested under items', () => {
    // The items key holds an array and the page key holds {items, total}. Sharing
    // one key handed the events rows an object and crashed the page in
    // production (tripl-lqxb) — so they must differ...
    expect(variablesPageKey('demo', 'branch-1')).not.toEqual(variablesKey('demo', 'branch-1'))

    // ...but the page key must stay a strict EXTENSION of the items key, because
    // every mutation invalidates the items key and React Query matches
    // invalidations by prefix. A sibling key would leave the settings table
    // showing deleted variables until a reload.
    const items = variablesKey('demo', 'branch-1')
    expect(variablesPageKey('demo', 'branch-1').slice(0, items.length)).toEqual([...items])
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
          // Scoped to the queryKey/invalidate context on purpose: 'variables'
          // is an ordinary word that appears in unrelated tuples elsewhere.
          || /queryKey:\s*\[\s*'variables'/.test(text)
          || /invalidateQueries\(\{\s*queryKey:\s*\[\s*'variables'/.test(text)
        )
      })
      .map((path) => path.slice(SRC.length + 1))

    expect(offenders).toEqual([])
  })
})
