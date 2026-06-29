import { api } from './client'
import type { DataSource, DataSourceTestResult, DbType, JsonPathDiscovery } from '../types'

export const dataSourcesApi = {
  list: () =>
    api.get<DataSource[]>('/data-sources'),

  get: (id: string) =>
    api.get<DataSource>(`/data-sources/${id}`),

  create: (data: {
    name: string
    db_type: DbType
    host: string
    port: number
    database_name: string
    username?: string
    password?: string
    timeout_seconds?: number | null
    json_path_discovery?: JsonPathDiscovery | null
  }) => api.post<DataSource>('/data-sources', data),

  update: (id: string, data: {
    name?: string
    db_type?: DbType
    host?: string
    port?: number
    database_name?: string
    username?: string
    password?: string
    timeout_seconds?: number | null
    json_path_discovery?: JsonPathDiscovery | null
  }) => api.patch<DataSource>(`/data-sources/${id}`, data),

  del: (id: string) =>
    api.del(`/data-sources/${id}`),

  testConnection: (id: string) =>
    api.post<DataSourceTestResult>(`/data-sources/${id}/test`, {}),
}
