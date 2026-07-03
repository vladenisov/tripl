import { useMemo, useState, type ComponentProps } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Eye, Loader2, Plus, Save, Trash2 } from 'lucide-react'
import { dataSourcesApi } from '@/api/dataSources'
import { factTablesApi } from '@/api/factTablesApi'
import { ErrorState } from '@/components/error-state'
import { SqlEditor } from '@/components/sql-editor'
import { useDataSourceSchema } from '@/hooks/useDataSourceSchema'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import {
  Field,
  SCard,
  Select,
  TextArea,
  TextInput,
  type SelectOption,
} from '@/components/settings/kit'
import type {
  DataSource,
  FactTable,
  FactTableColumn,
  FactTableCreate,
  FactTablePreviewResponse,
  FactTableRowFilter,
  FactTableUpdate,
} from '@/types'

const DEFAULT_COLOR = '#6366f1'

function toOptions(prefix: string, items: { value: string; label: string }[]): SelectOption[] {
  return [{ value: '', label: prefix }, ...items]
}

// Bucket a raw warehouse type string into a coarse family for the badge tone.
// The badge text always shows the raw type; the tone is purely a visual cue.
function typeTone(raw: string): ChipTone {
  const t = raw.toLowerCase()
  if (/(int|numeric|decimal|float|double|real|number|serial)/.test(t)) return 'accent'
  if (/(timestamp|date|time)/.test(t)) return 'info'
  if (/(bool)/.test(t)) return 'success'
  return 'neutral'
}

// kit's Field has no `required` flag; this thin wrapper renders the red marker
// to the right of the label when a field is required (mirrors MetricForm).
function FField({ required, ...props }: { required?: boolean } & ComponentProps<typeof Field>) {
  const labelRight = required ? (
    <span style={{ color: 'var(--danger)' }}>*</span>
  ) : (
    props.labelRight
  )
  return <Field {...props} labelRight={labelRight} />
}

// A row-filter entry with a stable client-side id. The editable list keys by
// this id rather than the array index, so removing a middle row no longer
// reuses a DOM node and jumps focus/cursor to the wrong row. The id is stripped
// before building the create/update payload (the API expects only name + sql).
interface RowFilterDraft extends FactTableRowFilter {
  id: string
}

interface FactTableFormProps {
  slug: string
  factTable: FactTable | null
  dataSources: DataSource[]
  onClose: () => void
}

/**
 * Create / edit a fact table. `name` is the per-project identity and is
 * immutable after creation (the backend rejects a change), so it is read-only
 * when editing. The SQL is a full read-only SELECT; "Preview columns"
 * introspects it server-side and populates the persisted `columns` +
 * `identifier_columns`. Server-side 4xx errors surface inline.
 */
export function FactTableForm({ slug, factTable, dataSources, onClose }: FactTableFormProps) {
  const qc = useQueryClient()
  const isNew = !factTable

  const [displayName, setDisplayName] = useState(factTable?.display_name ?? '')
  const [name, setName] = useState(factTable?.name ?? '')
  const [description, setDescription] = useState(factTable?.description ?? '')
  const [color, setColor] = useState(factTable?.color ?? DEFAULT_COLOR)
  const [dataSourceId, setDataSourceId] = useState(factTable?.data_source_id ?? '')
  const [sql, setSql] = useState(factTable?.sql ?? '')
  const [timestampColumn, setTimestampColumn] = useState(factTable?.timestamp_column ?? '')

  // Persisted introspection: populated by a successful preview, seeded from the
  // existing fact table when editing.
  const [columns, setColumns] = useState<FactTableColumn[]>(factTable?.columns ?? [])
  const [identifierColumns, setIdentifierColumns] = useState<string[]>(
    factTable?.identifier_columns ?? [],
  )
  const [identifierCandidates, setIdentifierCandidates] = useState<string[]>(
    factTable?.identifier_columns ?? [],
  )
  const [rowFilters, setRowFilters] = useState<RowFilterDraft[]>(() =>
    (factTable?.row_filters ?? []).map(filter => ({ ...filter, id: crypto.randomUUID() })),
  )

  const [formErrors, setFormErrors] = useState<string[]>([])

  const dataSourceOptions = useMemo(
    () => toOptions('Select data source…', dataSources.map(ds => ({ value: ds.id, label: ds.name }))),
    [dataSources],
  )

  // Drive the SQL editor's dialect highlighting + schema-aware autocomplete from
  // the selected data source (same wiring as the scans base-query editor).
  const selectedDataSource = useMemo(
    () => dataSources.find(ds => ds.id === dataSourceId),
    [dataSources, dataSourceId],
  )
  const { data: sqlSchemaData } = useDataSourceSchema(dataSourceId || undefined)

  const previewMut = useMutation({
    mutationFn: (): Promise<FactTablePreviewResponse> =>
      factTablesApi.preview(slug, {
        data_source_id: dataSourceId || null,
        sql,
        timestamp_column: timestampColumn.trim() || null,
      }),
    onSuccess: res => {
      setColumns(res.columns)
      setIdentifierCandidates(res.identifier_candidates)
      // Pre-select the backend's suggested identifier columns; the user can
      // refine the selection before saving.
      setIdentifierColumns(res.identifier_candidates)
    },
  })

  function validate(): string[] {
    const errs: string[] = []
    if (!displayName.trim()) errs.push('Display name is required.')
    if (isNew && !name.trim()) errs.push('Internal name is required.')
    if (!dataSourceId) errs.push('A data source is required.')
    if (!sql.trim()) errs.push('The fact table SQL is required.')
    if (!timestampColumn.trim()) errs.push('A timestamp column is required.')
    return errs
  }

  function cleanRowFilters(): FactTableRowFilter[] {
    return rowFilters
      .map(f => ({ name: f.name.trim(), sql: f.sql.trim() }))
      .filter(f => f.name && f.sql)
  }

  function buildCreatePayload(): FactTableCreate {
    return {
      color,
      columns,
      data_source_id: dataSourceId || null,
      description,
      display_name: displayName.trim(),
      identifier_columns: identifierColumns,
      name: name.trim(),
      row_filters: cleanRowFilters(),
      sql,
      timestamp_column: timestampColumn.trim(),
    }
  }

  function buildUpdatePayload(): FactTableUpdate {
    // `name` is immutable, so it is intentionally excluded from the update.
    return {
      color,
      columns,
      data_source_id: dataSourceId || null,
      description,
      display_name: displayName.trim(),
      identifier_columns: identifierColumns,
      row_filters: cleanRowFilters(),
      sql,
      timestamp_column: timestampColumn.trim(),
    }
  }

  const saveMut = useMutation({
    mutationFn: () =>
      factTable
        ? factTablesApi.update(slug, factTable.id, buildUpdatePayload())
        : factTablesApi.create(slug, buildCreatePayload()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['fact-tables', slug] })
      if (factTable) void qc.invalidateQueries({ queryKey: ['fact-table', slug] })
      onClose()
    },
  })

  const onSubmit = () => {
    const errs = validate()
    setFormErrors(errs)
    if (errs.length > 0) return
    saveMut.mutate()
  }

  const toggleIdentifier = (columnName: string) => {
    setIdentifierColumns(current =>
      current.includes(columnName)
        ? current.filter(c => c !== columnName)
        : [...current, columnName],
    )
  }

  const addRowFilter = () => {
    setRowFilters(current => [...current, { id: crypto.randomUUID(), name: '', sql: '' }])
  }

  const updateRowFilter = (id: string, patch: Partial<FactTableRowFilter>) => {
    setRowFilters(current =>
      current.map(filter => (filter.id === id ? { ...filter, ...patch } : filter)),
    )
  }

  const removeRowFilter = (id: string) => {
    setRowFilters(current => current.filter(filter => filter.id !== id))
  }

  return (
    <div className="h-full overflow-y-auto">
      <form
        onSubmit={e => {
          e.preventDefault()
          onSubmit()
        }}
        className="mx-auto max-w-[880px] px-6 pb-12 pt-4"
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-[14px] inline-flex items-center gap-1 text-[11.5px] transition-colors hover:text-[var(--fg)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <ChevronLeft size={13} /> Fact tables
        </button>
        <h1 className="mb-[18px] text-[19px] font-semibold tracking-[-0.01em]">
          {isNew ? 'New fact table' : 'Edit fact table'}
        </h1>

        <SCard title="Details">
          <FField label="Display name" htmlFor="fact-display-name" required>
            <TextInput
              id="fact-display-name"
              value={displayName}
              onChange={setDisplayName}
              placeholder="Orders"
              aria-required
            />
          </FField>
          <FField
            label="Internal name"
            htmlFor={isNew ? 'fact-name' : undefined}
            required={isNew}
            hint={isNew ? 'Stable identifier used by fact metrics.' : "Can't be changed after creation."}
          >
            {isNew ? (
              <TextInput id="fact-name" value={name} onChange={setName} mono placeholder="orders" aria-required />
            ) : (
              <div className="mono text-[13px]" style={{ color: 'var(--fg)' }}>
                {name}
              </div>
            )}
          </FField>
          <FField label="Description" htmlFor="fact-description">
            <TextArea
              id="fact-description"
              value={description}
              onChange={setDescription}
              rows={2}
              placeholder="What does this fact table represent?"
            />
          </FField>
          <FField label="Color" htmlFor="fact-color" last>
            <input
              id="fact-color"
              type="color"
              value={color}
              onChange={e => setColor(e.target.value)}
              className="h-8 w-12 cursor-pointer rounded border bg-transparent"
              style={{ borderColor: 'var(--border)' }}
            />
          </FField>
        </SCard>

        <SCard title="Source" description="A full read-only SELECT plus the warehouse it runs against.">
          <FField label="Data source" htmlFor="fact-data-source" required>
            <Select
              id="fact-data-source"
              value={dataSourceId}
              onChange={setDataSourceId}
              options={dataSourceOptions}
              aria-required
            />
          </FField>
          <FField label="SQL" htmlFor="fact-sql" required stacked hint="A single read-only SELECT.">
            <SqlEditor
              id="fact-sql"
              ariaLabel="Fact table SQL"
              value={sql}
              onChange={setSql}
              placeholder="SELECT id, user_id, amount, created_at FROM orders"
              dialect={selectedDataSource?.db_type}
              tables={sqlSchemaData?.tables}
              minHeight="160px"
            />
          </FField>
          <FField
            label="Timestamp column"
            htmlFor="fact-timestamp"
            required
            last
            hint="The column used to bucket facts over time."
          >
            <TextInput
              id="fact-timestamp"
              value={timestampColumn}
              onChange={setTimestampColumn}
              mono
              placeholder="created_at"
              aria-required
            />
          </FField>
        </SCard>

        <SCard
          title="Columns"
          description="Preview introspects the SELECT and records its columns and identifier candidates."
        >
          <div className="px-[18px] py-[15px]">
            <button
              type="button"
              onClick={() => previewMut.mutate()}
              disabled={previewMut.isPending || !sql.trim() || !dataSourceId}
              className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-60"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              {previewMut.isPending ? (
                <Loader2 className="animate-spin" size={12} />
              ) : (
                <Eye size={12} />
              )}
              Preview columns
            </button>

            {previewMut.isError && (
              <div className="mt-3">
                <ErrorState compact title="Could not preview columns" error={previewMut.error} />
              </div>
            )}

            {columns.length > 0 && (
              <div className="mt-4">
                <div
                  className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  Columns
                </div>
                <ul className="space-y-1.5" aria-label="Fact table columns">
                  {columns.map(column => {
                    const isIdentifier = identifierColumns.includes(column.name)
                    return (
                      <li
                        key={column.name}
                        className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <label className="flex items-center gap-2 text-[12.5px]">
                            <input
                              type="checkbox"
                              checked={isIdentifier}
                              onChange={() => toggleIdentifier(column.name)}
                              aria-label={`Use ${column.name} as an identifier column`}
                            />
                            <span className="mono truncate" style={{ color: 'var(--fg)' }}>
                              {column.name}
                            </span>
                          </label>
                          {isIdentifier && (
                            <Chip tone="accent" size="xs">
                              identifier
                            </Chip>
                          )}
                        </span>
                        <Chip tone={typeTone(column.type)} size="xs">
                          {column.type}
                        </Chip>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {identifierCandidates.length > 0 && (
              <div className="mt-3 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                Suggested identifiers:{' '}
                <span className="mono" style={{ color: 'var(--fg)' }}>
                  {identifierCandidates.join(', ')}
                </span>
              </div>
            )}
          </div>
        </SCard>

        <SCard
          title="Row filters"
          description="Reusable named WHERE fragments fact metrics can apply."
        >
          <div className="px-[18px] py-[15px]">
            {rowFilters.length === 0 ? (
              <div className="text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                No row filters yet.
              </div>
            ) : (
              <ul className="space-y-2" aria-label="Row filters">
                {rowFilters.map((filter, index) => (
                  <li key={filter.id} className="flex items-start gap-2">
                    <div className="w-[180px] shrink-0">
                      <TextInput
                        value={filter.name}
                        onChange={value => updateRowFilter(filter.id, { name: value })}
                        placeholder="mobile_only"
                        aria-label={`Row filter ${index + 1} name`}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <TextInput
                        value={filter.sql}
                        onChange={value => updateRowFilter(filter.id, { sql: value })}
                        mono
                        placeholder="platform = 'ios'"
                        aria-label={`Row filter ${index + 1} SQL condition`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRowFilter(filter.id)}
                      aria-label={`Remove row filter ${index + 1}`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] border transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={addRowFilter}
              className="mt-3 inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              <Plus size={12} /> Add row filter
            </button>
          </div>
        </SCard>

        {formErrors.length > 0 && (
          <div
            role="alert"
            className="mb-[18px] rounded-[10px] border px-4 py-3 text-[12.5px]"
            style={{
              background: 'var(--danger-soft)',
              borderColor: 'color-mix(in oklab, var(--danger) 35%, var(--border))',
              color: 'var(--danger)',
            }}
          >
            <ul className="list-disc space-y-1 pl-4">
              {formErrors.map(error => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {saveMut.isError && (
          <div className="mb-[18px]">
            <ErrorState compact title="Could not save fact table" error={saveMut.error} />
          </div>
        )}

        <div className="mt-1 flex justify-end gap-[10px]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saveMut.isPending}
            className="inline-flex h-8 items-center gap-[6px] rounded-[7px] px-3 text-[12px] font-medium disabled:opacity-60"
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {saveMut.isPending ? (
              <Loader2 className="animate-spin" size={12} />
            ) : isNew ? (
              <Plus size={12} />
            ) : (
              <Save size={12} />
            )}
            {isNew ? 'Create fact table' : 'Save fact table'}
          </button>
        </div>
      </form>
    </div>
  )
}

const EMPTY_DATA_SOURCES: DataSource[] = []

/**
 * Route wrapper: loads the data the form needs (data sources, and — when
 * editing — the fact table itself) and renders the form full-page. Reached via
 * `/p/:slug/metrics/fact-tables/new` and
 * `/p/:slug/metrics/fact-tables/:factTableId/edit` (fact tables are a tab under
 * Metrics), so closing returns to the Fact tables tab.
 */
export default function FactTableEditPage() {
  const { slug, factTableId } = useParams<{ slug: string; factTableId?: string }>()
  const navigate = useNavigate()
  const isNew = !factTableId

  const goBack = () => navigate(`/p/${slug}/metrics/fact-tables`)

  const dataSourcesQuery = useQuery({
    queryKey: ['data-sources'],
    queryFn: () => dataSourcesApi.list(),
  })
  const factTableQuery = useQuery({
    queryKey: ['fact-table', slug, factTableId],
    queryFn: () => factTablesApi.get(slug!, factTableId!),
    enabled: !!slug && !!factTableId,
  })

  const loadError = dataSourcesQuery.error ?? factTableQuery.error
  if (loadError) {
    return (
      <div className="mx-auto max-w-[880px] p-6">
        <ErrorState
          title="Failed to load fact table editor"
          error={loadError}
          onRetry={() => {
            void Promise.all([
              dataSourcesQuery.refetch(),
              ...(factTableId ? [factTableQuery.refetch()] : []),
            ])
          }}
        />
      </div>
    )
  }

  const isLoading = dataSourcesQuery.isLoading || (!isNew && factTableQuery.isLoading)
  if (isLoading || !slug) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
        Loading…
      </div>
    )
  }

  return (
    <FactTableForm
      slug={slug}
      factTable={factTableQuery.data ?? null}
      dataSources={dataSourcesQuery.data ?? EMPTY_DATA_SOURCES}
      onClose={goBack}
    />
  )
}
