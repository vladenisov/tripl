export interface ColumnSchema {
  name: string
  data_type: string
}

export interface TableSchema {
  name: string
  columns: ColumnSchema[]
}

export interface DataSourceSchemaResponse {
  tables: TableSchema[]
}
