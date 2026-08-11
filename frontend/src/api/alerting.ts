import { api } from './client'
import type {
  AlertDeliveryDetail,
  AlertInboxGroup,
  AlertInboxListResponse,
  AlertDeliveryListResponse,
  AlertDestination,
  AlertRule,
  AlertRuleFilterPayload,
  AlertRuleSimulateResponse,
  MonitorDetail,
  MonitorsSummaryResponse,
} from '../types'

export const alertingApi = {
  listDestinations: (slug: string) =>
    api.get<AlertDestination[]>(`/projects/${slug}/alert-destinations`),

  getMonitorsSummary: (slug: string) =>
    api.get<MonitorsSummaryResponse>(`/projects/${slug}/monitors-summary`),

  createDestination: (
    slug: string,
    data: {
      type: 'slack' | 'telegram' | 'webhook' | 'email' | 'jira' | 'linear'
      name: string
      enabled?: boolean
      webhook_url?: string | null
      bot_token?: string | null
      chat_id?: string | null
      target_url?: string | null
      webhook_header_name?: string | null
      webhook_header_value?: string | null
      email_recipients?: string | null
      email_from_address?: string | null
      email_subject_template?: string | null
      jira_base_url?: string | null
      jira_auth_email?: string | null
      jira_api_token?: string | null
      jira_project_key?: string | null
      jira_issue_type?: string | null
      linear_api_key?: string | null
      linear_team_id?: string | null
      linear_state_id?: string | null
      linear_label_ids?: string | null
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
      target_url?: string | null
      webhook_header_name?: string | null
      webhook_header_value?: string | null
      email_recipients?: string | null
      email_from_address?: string | null
      email_subject_template?: string | null
      jira_base_url?: string | null
      jira_auth_email?: string | null
      jira_api_token?: string | null
      jira_project_key?: string | null
      jira_issue_type?: string | null
      linear_api_key?: string | null
      linear_team_id?: string | null
      linear_state_id?: string | null
      linear_label_ids?: string | null
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
      include_distribution_drifts?: boolean
      include_release_regressions?: boolean
      include_variable_value_drifts?: boolean
      notify_on_spike?: boolean
      notify_on_drop?: boolean
      ai_explanation_enabled?: boolean
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
      include_distribution_drifts?: boolean
      include_release_regressions?: boolean
      include_variable_value_drifts?: boolean
      notify_on_spike?: boolean
      notify_on_drop?: boolean
      ai_explanation_enabled?: boolean
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

  simulateRule: (
    slug: string,
    destinationId: string,
    ruleId: string,
    days: number,
    cooldownMinutesOverride?: number,
  ) => {
    const params = new URLSearchParams({ days: String(days) })
    if (cooldownMinutesOverride !== undefined) {
      params.set('cooldown_minutes_override', String(cooldownMinutesOverride))
    }
    return api.post<AlertRuleSimulateResponse>(
      `/projects/${slug}/alert-destinations/${destinationId}/rules/${ruleId}/simulate?${params}`,
      undefined,
    )
  },

  listDeliveries: (
    slug: string,
    params?: {
      status?: string
      channel?: string
      destination_id?: string
      rule_id?: string
      scan_config_id?: string
      /** One incident's deliveries — what the incident card lists under it. */
      correlation_group_id?: string
      /**
       * Deliveries belonging to no incident. Not expressible through
       * `correlation_group_id`, and without it they would vanish from a page
       * that lists deliveries under incidents.
       */
      ungrouped?: boolean
      date_from?: string
      date_to?: string
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
    if (params?.correlation_group_id) sp.set('correlation_group_id', params.correlation_group_id)
    if (params?.ungrouped) sp.set('ungrouped', 'true')
    if (params?.date_from) sp.set('date_from', params.date_from)
    if (params?.date_to) sp.set('date_to', params.date_to)
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return api.get<AlertDeliveryListResponse>(`/projects/${slug}/alert-deliveries${qs ? `?${qs}` : ''}`)
  },

  getDelivery: (slug: string, deliveryId: string) =>
    api.get<AlertDeliveryDetail>(`/projects/${slug}/alert-deliveries/${deliveryId}`),

  retryDelivery: (slug: string, deliveryId: string) =>
    api.post<AlertDeliveryDetail>(
      `/projects/${slug}/alert-deliveries/${deliveryId}/retry`,
      undefined,
    ),

  getMonitor: (slug: string, ruleId: string) =>
    api.get<MonitorDetail>(`/projects/${slug}/monitors/${ruleId}`),

  getMonitorHistory: (
    slug: string,
    ruleId: string,
    params?: {
      status?: string
      channel?: string
      date_from?: string
      date_to?: string
      offset?: number
      limit?: number
    },
  ) => {
    const sp = new URLSearchParams()
    sp.set('rule_id', ruleId)
    if (params?.status) sp.set('status', params.status)
    if (params?.channel) sp.set('channel', params.channel)
    if (params?.date_from) sp.set('date_from', params.date_from)
    if (params?.date_to) sp.set('date_to', params.date_to)
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    return api.get<AlertDeliveryListResponse>(
      `/projects/${slug}/alert-deliveries?${sp.toString()}`,
    )
  },

  muteMonitor: (slug: string, ruleId: string, mutedUntil: string) =>
    api.post<MonitorDetail>(`/projects/${slug}/monitors/${ruleId}/mute`, {
      muted_until: mutedUntil,
    }),

  unmuteMonitor: (slug: string, ruleId: string) =>
    api.post<MonitorDetail>(`/projects/${slug}/monitors/${ruleId}/unmute`, undefined),

  listInbox: (
    slug: string,
    params?: { status?: string; offset?: number; limit?: number },
  ) => {
    const sp = new URLSearchParams()
    if (params?.status) sp.set('status', params.status)
    if (params?.offset !== undefined) sp.set('offset', String(params.offset))
    if (params?.limit !== undefined) sp.set('limit', String(params.limit))
    const qs = sp.toString()
    return api.get<AlertInboxListResponse>(`/projects/${slug}/alert-inbox${qs ? `?${qs}` : ''}`)
  },

  applyInboxAction: (
    slug: string,
    correlationGroupId: string,
    data: {
      action: 'acknowledge' | 'resolve' | 'mute' | 'reopen' | 'false_positive'
      note?: string | null
      muted_until?: string | null
    },
  ) => api.post<AlertInboxGroup>(`/projects/${slug}/alert-inbox/${correlationGroupId}/actions`, data),
}
