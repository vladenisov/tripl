import { api } from './client'
import type { Role, UserListItem } from '../types'

export const usersApi = {
  list: () => api.get<UserListItem[]>('/users'),
  updateRole: (userId: string, role: Role) =>
    api.patch<UserListItem>(`/users/${userId}`, { role }),
}
