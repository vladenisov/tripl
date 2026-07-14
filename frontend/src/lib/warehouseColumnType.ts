export type WarehouseColumnValueKind = 'number' | 'boolean' | 'string'

/**
 * Reduce ClickHouse, BigQuery and PostgreSQL column type names to the scalar
 * kind needed by fact-condition serialization and display. Wrappers such as
 * Nullable(...) / Array(...) are intentionally tolerated by matching within
 * the full introspected type string.
 */
export function warehouseColumnValueKind(
  columnType: string | null | undefined,
): WarehouseColumnValueKind {
  if (!columnType) return 'string'
  if (/\b(?:bool|boolean)\b/i.test(columnType)) return 'boolean'
  if (
    /\b(?:u?int\d*|integer|smallint|bigint|float\d*|decimal|numeric|bignumeric|number|real|double(?:\s+precision)?|serial|bigserial|money)\b/i.test(
      columnType,
    )
  ) {
    return 'number'
  }
  return 'string'
}
