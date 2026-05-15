export type EventsSavedView = {
  name: string
  tab: string
  params: string
  updated_at: string
}

type StoredEventsSavedViews = Record<string, Record<string, Omit<EventsSavedView, 'name'>>>

const STORAGE_KEY = 'tripl.eventsSavedViews'
let memoryStore: string | null = null

function readStore(): StoredEventsSavedViews {
  try {
    const raw = typeof localStorage.getItem === 'function'
      ? localStorage.getItem(STORAGE_KEY)
      : memoryStore
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as StoredEventsSavedViews
  } catch {
    return {}
  }
}

function writeStore(store: StoredEventsSavedViews) {
  const serialized = JSON.stringify(store)
  try {
    if (typeof localStorage.setItem === 'function') {
      localStorage.setItem(STORAGE_KEY, serialized)
      return
    }
  } catch {
    // Ignore storage quota/private-mode failures; saved views are optional UI state.
  }
  memoryStore = serialized
}

export function loadEventsSavedViews(slug: string): EventsSavedView[] {
  const projectViews = readStore()[slug] ?? {}
  return Object.entries(projectViews)
    .map(([name, view]) => ({ name, ...view }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function saveEventsSavedView(
  slug: string,
  view: Pick<EventsSavedView, 'name' | 'tab' | 'params'>,
): EventsSavedView[] {
  const name = view.name.trim()
  if (!name) return loadEventsSavedViews(slug)
  const store = readStore()
  store[slug] = {
    ...(store[slug] ?? {}),
    [name]: {
      tab: view.tab,
      params: view.params,
      updated_at: new Date().toISOString(),
    },
  }
  writeStore(store)
  return loadEventsSavedViews(slug)
}

export function deleteEventsSavedView(slug: string, name: string): EventsSavedView[] {
  const store = readStore()
  const projectViews = store[slug]
  if (!projectViews) return []
  delete projectViews[name]
  if (Object.keys(projectViews).length === 0) {
    delete store[slug]
  }
  writeStore(store)
  return loadEventsSavedViews(slug)
}
