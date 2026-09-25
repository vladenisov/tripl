import { act } from '@testing-library/react'
import { expect } from 'vitest'
import { axe } from 'vitest-axe'

/**
 * Runs axe over a rendered tree and fails on any violation. Pass
 * `document.body` for anything that renders through a portal (dialogs,
 * popovers), since their content is not inside the render container.
 *
 * `color-contrast` is off because jsdom does no layout or style cascade, so axe
 * cannot compute it here; theme-contrast.test.ts checks the palette instead.
 * `region` (all content inside landmarks) is a property of a whole page, so it
 * only runs when the tree is one: pass `{ page: true }` for a render that
 * includes the app shell.
 *
 * axe is asynchronous, and queries the tree started keep resolving while it
 * runs; doing it inside act() lets those updates land where React expects them.
 */
export async function expectNoAxeViolations(
  root: Element,
  { page = false }: { page?: boolean } = {},
): Promise<void> {
  const results = await act(() =>
    axe(root, {
      rules: {
        'color-contrast': { enabled: false },
        region: { enabled: page },
      },
    }),
  )
  expect(results).toHaveNoViolations()
}
