export type DbType = 'clickhouse' | 'postgres' | 'bigquery'

export const DB_TYPE_OPTIONS: { value: DbType; label: string; defaultPort: number }[] = [
  { value: 'clickhouse', label: 'ClickHouse', defaultPort: 8123 },
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'bigquery', label: 'BigQuery', defaultPort: 0 },
]

export type DataSourceTestStatus = 'success' | 'failed'

export interface DataSource {
  id: string
  name: string
  db_type: DbType
  host: string
  port: number
  database_name: string
  username: string
  password_set: boolean
  timeout_seconds: number | null
  extra_params: Record<string, unknown> | null
  last_test_at: string | null
  last_test_status: DataSourceTestStatus | null
  last_test_message: string | null
  created_at: string
  updated_at: string
}

export interface DataSourceTestResult {
  success: boolean
  message: string
  tested_at: string
  data_source: DataSource
}
