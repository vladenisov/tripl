import { api } from './client'
import type { ApiKey, ApiKeyScope, ApiKeyWithToken } from '../types'

export const apiKeysApi = {
  list: () => api.get<ApiKey[]>('/me/api-keys'),
  create: (data: { name: string; scope: ApiKeyScope; expires_in_days?: number | null }) =>
    api.post<ApiKeyWithToken>('/me/api-keys', data),
  revoke: (keyId: string) => api.del(`/me/api-keys/${keyId}`),
}
