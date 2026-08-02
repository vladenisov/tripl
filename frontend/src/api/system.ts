import { api } from './client'
import type { WorkerHealth } from '@/types'

export const systemApi = {
  workerHealth: () => api.get<WorkerHealth>('/system/worker-health'),
}
