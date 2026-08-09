import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ScanConfigPreview } from '@/types'
import { isJsonPreviewType, SELECT_CLASS } from './scanUtils'

export function AppVersionFields({
  columns,
  appVersionColumn,
  prereleasePattern,
  activeShareMin,
  platformColumn,
  onAppVersionColumnChange,
  onPrereleasePatternChange,
  onActiveShareMinChange,
  onPlatformColumnChange,
}: {
  columns: ScanConfigPreview['columns'] | null
  appVersionColumn: string
  prereleasePattern: string
  activeShareMin: string
  platformColumn: string
  onAppVersionColumnChange: (column: string) => void
  onPrereleasePatternChange: (value: string) => void
  onActiveShareMinChange: (value: string) => void
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
          <Label htmlFor="app-version-column">App version column</Label>
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
          <Label htmlFor="platform-column">Platform column</Label>
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
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-2">
          <Label htmlFor="app-version-prerelease-pattern">Pre-release version pattern</Label>
          <Input
            id="app-version-prerelease-pattern"
            type="text"
            value={prereleasePattern}
            onChange={e => onPrereleasePatternChange(e.target.value)}
            disabled={!appVersionColumn}
            placeholder={appVersionColumn ? 'e.g. -(beta|rc)' : 'Select version column'}
          />
          <p className="text-xs text-muted-foreground">
            Regex marking beta builds, e.g. -(beta|rc). Matching versions stay out of release comparisons.
          </p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="app-version-active-share">Traffic share that counts as released</Label>
          <Input
            id="app-version-active-share"
            type="number"
            min={0.01}
            max={0.99}
            step={0.01}
            value={activeShareMin}
            onChange={e => onActiveShareMinChange(e.target.value)}
            disabled={!appVersionColumn}
            placeholder={appVersionColumn ? 'Default 0.05' : 'Select version column'}
          />
          <p className="text-xs text-muted-foreground">
            A version counts as released once it carries this share of traffic. Default 0.05 (5%).
          </p>
        </div>
      </div>
    </div>
  )
}
