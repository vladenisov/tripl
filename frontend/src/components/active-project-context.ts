import { createContext } from 'react'

import type { Project } from '@/types'

/**
 * The project the app shell resolved for the `/p/:slug` in the URL, or
 * `undefined` outside a project (and in a component mounted without the shell).
 *
 * Layout resolves it before any project page mounts; this hands that answer
 * down so a per-control predicate ({@link useCanWriteProject}) reads one value
 * instead of every row of a table subscribing to the query cache.
 */
export const ActiveProjectContext = createContext<Project | undefined>(undefined)
