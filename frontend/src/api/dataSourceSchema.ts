import { api } from './client'
import type { DataSourceSchemaResponse } from '../types/dataSourceSchema'

export const dataSourceSchemaApi = {
  get: (dsId: string) =>
    api.get<DataSourceSchemaResponse>(`/data-sources/${dsId}/schema`),
}
