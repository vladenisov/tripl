import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ScanConfigPreview } from '@/types'
import { isJsonPreviewType, SELECT_CLASS } from './scanUtils'

export function AppVersionFields({
  columns,
  appVersionColumn,
  keepReleases,
  platformColumn,
  onAppVersionColumnChange,
  onKeepReleasesChange,
  onPlatformColumnChange,
}: {
  columns: ScanConfigPreview['columns'] | null
  appVersionColumn: string
  keepReleases: string
  platformColumn: string
  onAppVersionColumnChange: (column: string) => void
  onKeepReleasesChange: (value: string) => void
  onPlatformColumnChange: (column: string) => void
}) {
  const availableColumns = columns?.filter(column => !isJsonPreviewType(column.type_name)) ?? []
  const hasSelectedColumn = Boolean(appVersionColumn)
  const selectedColumnIsAvailable = availableColumns.some(column => column.name === appVersionColumn)
  const selectDisabled = !columns && !hasSelectedColumn

  const hasSelectedPlatform = Boolean(platformColumn)
  const selectedPlatformIsAvailable = availableColumns.some(column => column.name === platformColumn)
  const platformSelectDisabled = !columns && !hasSelectedPlatform

  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="app-version-column">App Version Column (optional)</Label>
          <select
            id="app-version-column"
            value={appVersionColumn}
            onChange={e => onAppVersionColumnChange(e.target.value)}
            className={SELECT_CLASS}
            disabled={selectDisabled}
          >
            <option value="">{columns || hasSelectedColumn ? 'No app version' : 'Load preview first'}</option>
            {hasSelectedColumn && !selectedColumnIsAvailable && (
              <option value={appVersionColumn}>{appVersionColumn}</option>
            )}
            {availableColumns.map(column => (
              <option key={column.name} value={column.name}>{column.name}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="app-version-keep-releases">Releases to keep</Label>
          <Input
            id="app-version-keep-releases"
            type="number"
            min={1}
            value={keepReleases}
            onChange={e => onKeepReleasesChange(e.target.value)}
            disabled={!appVersionColumn}
            placeholder={appVersionColumn ? 'Default' : 'Select version column'}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="platform-column">Platform Column (optional)</Label>
        <select
          id="platform-column"
          value={platformColumn}
          onChange={e => onPlatformColumnChange(e.target.value)}
          className={SELECT_CLASS}
          disabled={platformSelectDisabled}
        >
          <option value="">{columns || hasSelectedPlatform ? 'No platform' : 'Load preview first'}</option>
          {hasSelectedPlatform && !selectedPlatformIsAvailable && (
            <option value={platformColumn}>{platformColumn}</option>
          )}
          {availableColumns.map(column => (
            <option key={column.name} value={column.name}>{column.name}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
