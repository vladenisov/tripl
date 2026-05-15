import { api } from './client'
import type {
  AlertDeliveryDetail,
  AlertDeliveryListResponse,
  AlertDestination,
  AlertRule,
  AlertRuleFilterPayload,
  AlertRuleSimulateResponse,
} from '../types'

export const alertingApi = {
  listDestinations: (slug: string) =>
    api.get<AlertDestination[]>(`/projects/${slug}/alert-destinations`),

  createDestination: (
    slug: string,
    data: {
      type: 'slack' | 'telegram'
      name: string
      enabled?: boolean
      webhook_url?: string | null
      bot_token?: string | null
      chat_id?: string | null
    },
  ) => api.post<AlertDestination>(`/projects/${slug}/alert-destinations`, data),

  updateDestination: (
    slug: string,
    destinationId: string,
    data: {
      name?: string
      enabled?: boolean
      webhook_url?: string | null
      bot_token?: string | null
      chat_id?: string | null
    },
  ) => api.patch<AlertDestination>(`/projects/${slug}/alert-destinations/${destinationId}`, data),

  deleteDestination: (slug: string, destinationId: string) =>
    api.del(`/projects/${slug}/alert-destinations/${destinationId}`),

  createRule: (
    slug: string,
    destinationId: string,
    data: {
      name: string
      enabled?: boolean
      include_project_total?: boolean
      include_event_types?: boolean
      include_events?: boolean
      include_schema_drifts?: boolean
      notify_on_spike?: boolean
      notify_on_drop?: boolean
      min_percent_delta?: number
      min_absolute_delta?: number
      min_expected_count?: number
      cooldown_minutes?: number
      message_template?: string | null
      items_template?: string | null
      message_format?: 'plain' | 'slack_mrkdwn' | 'telegram_html' | 'telegram_markdownv2'
      filters?: AlertRuleFilterPayload[]
    },
  ) => api.post<AlertRule>(`/projects/${slug}/alert-destinations/${destinationId}/rules`, data),

  updateRule: (
    slug: string,
    destinationId: string,
    ruleId: string,
    data: {
      name?: string
      enabled?: boolean
      include_project_total?: boolean
      include_event_types?: boolean
      include_events?: boolean
      include_schema_drifts?: boolean
      notify_on_spike?: boolean
      notify_on_drop?: boolean
      min_percent_delta?: number
      min_absolute_delta?: number
      min_expected_count?: number
      cooldown_minutes?: number
      message_template?: string | null
      items_template?: string | null
      message_format?: 'plain' | 'slack_mrkdwn' | 'telegram_html' | 'telegram_markdownv2'
      filters?: AlertRuleFilterPayload[]
    },
  ) => api.patch<AlertRule>(`/projects/${slug}/alert-destinations/${destinationId}/rules/${ruleId}`, data),

  deleteRule: (slug: string, destinationId: string, ruleId: string) =>
    api.del(`/projects/${slug}/alert-destinations/${destinationId}/rules/${ruleId}`),

  simulateRule: (slug: string, destinationId: string, ruleId: string, days: number) =>
    api.post<AlertRuleSimulateResponse>(
      `/projects/${slug}/alert-destinations/${destinationId}/rules/${ruleId}/simulate?days=${days}`,
      undefined,
    ),

  listDeliveries: (
    slug: string,
    params?: {
      status?: string
      channel?: string
      destination_id?: string
      rule_id?: string
      scan_config_id?: string
      offset?: number
      limit?: number
    },
  ) => {
    const sp = new URLSearchParams()
    if (params?.status) sp.set('status', params.status)
    if (params?.channel) sp.set('channel', params.channel)
    if (params?.destination_id) sp.set('destination_id', params.destination_id)
    if (params?.rule_id) sp.set('rule_id', params.rule_id)
    if (params?.scan_config_id) sp.set('scan_config_id', params.scan_config_id)
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return api.get<AlertDeliveryListResponse>(`/projects/${slug}/alert-deliveries${qs ? `?${qs}` : ''}`)
  },

  getDelivery: (slug: string, deliveryId: string) =>
    api.get<AlertDeliveryDetail>(`/projects/${slug}/alert-deliveries/${deliveryId}`),
}
