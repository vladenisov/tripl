import { api } from './client'
import type {
  FactTable,
  FactTableCreate,
  FactTableListResponse,
  FactTablePreviewRequest,
  FactTablePreviewResponse,
  FactTableUpdate,
} from '../types'

/**
 * Fact-table CRUD plus the `preview` introspection surface. Mirrors the
 * thin-wrapper style of `metricsCatalogApi`: each call is typed off the
 * committed OpenAPI schemas and delegates error handling to the base client.
 */
export const factTablesApi = {
  list: (slug: string): Promise<FactTableListResponse> =>
    api.get<FactTableListResponse>(`/projects/${slug}/fact-tables`),

  get: (slug: string, factTableId: string): Promise<FactTable> =>
    api.get<FactTable>(`/projects/${slug}/fact-tables/${factTableId}`),

  create: (slug: string, body: FactTableCreate): Promise<FactTable> =>
    api.post<FactTable>(`/projects/${slug}/fact-tables`, body),

  update: (slug: string, factTableId: string, body: FactTableUpdate): Promise<FactTable> =>
    api.patch<FactTable>(`/projects/${slug}/fact-tables/${factTableId}`, body),

  remove: (slug: string, factTableId: string): Promise<void> =>
    api.del<void>(`/projects/${slug}/fact-tables/${factTableId}`),

  preview: (slug: string, body: FactTablePreviewRequest): Promise<FactTablePreviewResponse> =>
    api.post<FactTablePreviewResponse>(`/projects/${slug}/fact-tables/preview`, body),
}
