import { useParams } from 'react-router-dom'
import { ScansTab } from './settings/ScansTab'
import { ScanConfigDetail } from './settings/ScanConfigDetailView'

/**
 * Govern › Scans, as a top-level project surface at `/p/:slug/scans`.
 *
 * Scans are an operational surface — you run them, watch them, and read what
 * they changed — not project configuration, so they no longer live under
 * `/settings`. This page is a thin dispatcher over the two components that
 * already existed as `ProjectSettingsPage` tab branches; both keep their
 * current props and import paths.
 *
 * It deliberately renders NO settings signpost. The old mount inherited
 * `ProjectSettingsPage`'s chrome, which framed the page as "Project
 * operations" while linking out to "Workspace settings" — two different
 * claims about what surface you were on, above a page that is neither.
 */
export default function ProjectScansPage() {
  const { slug, scanId } = useParams<{ slug: string; scanId?: string }>()
  if (!slug) return null
  return scanId
    ? <ScanConfigDetail slug={slug} scanConfigId={scanId} />
    : <ScansTab slug={slug} />
}
