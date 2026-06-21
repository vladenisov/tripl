import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ClipboardList, Globe, Mail, Send, Ticket, Trash2, Webhook } from 'lucide-react'

import { alertingApi } from '@/api/alerting'
import { eventTypesApi } from '@/api/eventTypes'
import { eventsApi } from '@/api/events'
import { scansApi } from '@/api/scans'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useConfirm } from '@/hooks/useConfirm'
import type { AlertDestination, AlertInboxGroup } from '@/types'

import { AlertDeliveryRow } from './alerting/AlertDeliveryRow'
import { DestinationCard } from './alerting/DestinationCard'
import { RoutingRulesPanel } from './alerting/RoutingRulesPanel'
import { PageHead, Panel } from '@/components/settings/kit'
import {
  defaultDestinationForm,
  type DestinationChannel,
  type DestinationFormState,
} from './alerting/constants'
import { getErrorMessage } from '@/lib/utils'

export default function ProjectAlertingTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [createType, setCreateType] = useState<DestinationChannel | null>(null)
  const [destinationForm, setDestinationForm] = useState<DestinationFormState>(defaultDestinationForm('slack'))
  const [editingDestination, setEditingDestination] = useState<AlertDestination | null>(null)
  const [deliveryFilters, setDeliveryFilters] = useState<{
    status: string
    channel: string
    destination_id: string
    rule_id: string
    scan_config_id: string
  }>({
    status: '',
    channel: '',
    destination_id: '',
    rule_id: '',
    scan_config_id: '',
  })

  const { data: destinations = [] } = useQuery({
    queryKey: ['alertDestinations', slug],
    queryFn: () => alertingApi.listDestinations(slug),
  })
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug),
  })
  const { data: eventsResp } = useQuery({
    queryKey: ['events', slug, 'alerting'],
    queryFn: () => eventsApi.list(slug, { limit: 10000, offset: 0 }),
  })
  const { data: scans = [] } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })
  const { data: deliveries } = useQuery({
    queryKey: ['alertDeliveries', slug, deliveryFilters],
    queryFn: () => alertingApi.listDeliveries(slug, {
      ...deliveryFilters,
      status: deliveryFilters.status || undefined,
      channel: deliveryFilters.channel || undefined,
      destination_id: deliveryFilters.destination_id || undefined,
      rule_id: deliveryFilters.rule_id || undefined,
      scan_config_id: deliveryFilters.scan_config_id || undefined,
      limit: 50,
      offset: 0,
    }),
  })
  const { data: inbox } = useQuery({
    queryKey: ['alertInbox', slug],
    queryFn: () => alertingApi.listInbox(slug, { limit: 20 }),
  })

  const events = eventsResp?.items ?? []
  const groupedDestinations = useMemo(() => ({
    slack: destinations.filter(destination => destination.type === 'slack'),
    telegram: destinations.filter(destination => destination.type === 'telegram'),
    webhook: destinations.filter(destination => destination.type === 'webhook'),
    email: destinations.filter(destination => destination.type === 'email'),
    jira: destinations.filter(destination => destination.type === 'jira'),
    linear: destinations.filter(destination => destination.type === 'linear'),
  }), [destinations])

  const allRules = destinations.flatMap(destination =>
    destination.rules.map(rule => ({
      ...rule,
      destination_name: destination.name,
      destination_id: destination.id,
    })))

  const createDestinationMut = useMutation({
    mutationFn: () => alertingApi.createDestination(slug, destinationForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alertDestinations', slug] })
      setCreateType(null)
      setDestinationForm(defaultDestinationForm('slack'))
    },
  })

  const updateDestinationMut = useMutation({
    mutationFn: () => {
      if (!editingDestination) throw new Error('Missing destination')
      return alertingApi.updateDestination(slug, editingDestination.id, {
        name: destinationForm.name,
        enabled: destinationForm.enabled,
        webhook_url: destinationForm.type === 'slack' && destinationForm.webhook_url ? destinationForm.webhook_url : undefined,
        bot_token: destinationForm.type === 'telegram' && destinationForm.bot_token ? destinationForm.bot_token : undefined,
        chat_id: destinationForm.type === 'telegram' ? destinationForm.chat_id : undefined,
        target_url: destinationForm.type === 'webhook' && destinationForm.target_url ? destinationForm.target_url : undefined,
        webhook_header_name: destinationForm.type === 'webhook' ? destinationForm.webhook_header_name : undefined,
        webhook_header_value: destinationForm.type === 'webhook' && destinationForm.webhook_header_value ? destinationForm.webhook_header_value : undefined,
        email_recipients: destinationForm.type === 'email' && destinationForm.email_recipients ? destinationForm.email_recipients : undefined,
        email_from_address: destinationForm.type === 'email' ? (destinationForm.email_from_address || null) : undefined,
        email_subject_template: destinationForm.type === 'email' ? (destinationForm.email_subject_template || null) : undefined,
        jira_base_url: destinationForm.type === 'jira' && destinationForm.jira_base_url ? destinationForm.jira_base_url : undefined,
        jira_auth_email: destinationForm.type === 'jira' && destinationForm.jira_auth_email ? destinationForm.jira_auth_email : undefined,
        jira_api_token: destinationForm.type === 'jira' && destinationForm.jira_api_token ? destinationForm.jira_api_token : undefined,
        jira_project_key: destinationForm.type === 'jira' && destinationForm.jira_project_key ? destinationForm.jira_project_key : undefined,
        jira_issue_type: destinationForm.type === 'jira' && destinationForm.jira_issue_type ? destinationForm.jira_issue_type : undefined,
        linear_api_key: destinationForm.type === 'linear' && destinationForm.linear_api_key ? destinationForm.linear_api_key : undefined,
        linear_team_id: destinationForm.type === 'linear' && destinationForm.linear_team_id ? destinationForm.linear_team_id : undefined,
        linear_state_id: destinationForm.type === 'linear' ? (destinationForm.linear_state_id || null) : undefined,
        linear_label_ids: destinationForm.type === 'linear' ? (destinationForm.linear_label_ids || null) : undefined,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alertDestinations', slug] })
      setEditingDestination(null)
      setDestinationForm(defaultDestinationForm('slack'))
    },
  })

  const deleteDestinationMut = useMutation({
    mutationFn: (destinationId: string) => alertingApi.deleteDestination(slug, destinationId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alertDestinations', slug] }),
  })

  const openCreate = (type: DestinationChannel) => {
    setCreateType(type)
    setEditingDestination(null)
    setDestinationForm(defaultDestinationForm(type))
  }

  const openEdit = (destination: AlertDestination) => {
    setEditingDestination(destination)
    setCreateType(null)
    setDestinationForm({
      type: destination.type,
      name: destination.name,
      enabled: destination.enabled,
      webhook_url: '',
      bot_token: '',
      chat_id: destination.chat_id ?? '',
      target_url: '',
      webhook_header_name: destination.webhook_header_name ?? '',
      webhook_header_value: '',
      email_recipients: destination.email_recipients ?? '',
      email_from_address: destination.email_from_address ?? '',
      email_subject_template: destination.email_subject_template ?? '',
      jira_base_url: destination.jira_base_url ?? '',
      jira_auth_email: destination.jira_auth_email ?? '',
      jira_api_token: '',
      jira_project_key: destination.jira_project_key ?? '',
      jira_issue_type: destination.jira_issue_type ?? 'Task',
      linear_api_key: '',
      linear_team_id: destination.linear_team_id ?? '',
      linear_state_id: destination.linear_state_id ?? '',
      linear_label_ids: destination.linear_label_ids ?? '',
    })
  }

  const closeDestinationDialog = () => {
    setCreateType(null)
    setEditingDestination(null)
    setDestinationForm(defaultDestinationForm('slack'))
  }

  const handleDeleteDestination = async (destination: AlertDestination) => {
    const ok = await confirm({
      title: 'Delete destination',
      message: `Delete "${destination.name}" and all its alert rules?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteDestinationMut.mutate(destination.id)
  }

  const destinationMutation = editingDestination ? updateDestinationMut : createDestinationMut

  const inboxActionMut = useMutation({
    mutationFn: ({
      group,
      action,
    }: {
      group: AlertInboxGroup
      action: 'acknowledge' | 'resolve' | 'mute' | 'reopen' | 'false_positive'
    }) => {
      const mutedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString()
      return alertingApi.applyInboxAction(slug, group.correlation_group_id, {
        action,
        ...(action === 'mute' ? { muted_until: mutedUntil } : {}),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alertInbox', slug] })
      qc.invalidateQueries({ queryKey: ['alertDeliveries', slug] })
      qc.invalidateQueries({ queryKey: ['scans', slug] })
    },
  })
  const activeDestinationType = editingDestination?.type ?? createType ?? destinationForm.type

  return (
    <div className="space-y-6">
      {dialog}
      <PageHead
        eyebrow="Observe"
        title="Alerting"
        description="Route active anomaly signals to Slack, Telegram, or a generic webhook. Rules are project-level and apply to every scan in the project."
      />

      <RoutingRulesPanel slug={slug} />

      <div className="grid gap-6">
        <div className="min-w-0 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Destinations</h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => openCreate('slack')}>
                <Webhook className="mr-2 h-4 w-4" />
                Add Slack
              </Button>
              <Button variant="outline" size="sm" onClick={() => openCreate('telegram')}>
                <Send className="mr-2 h-4 w-4" />
                Add Telegram
              </Button>
              <Button variant="outline" size="sm" onClick={() => openCreate('webhook')}>
                <Globe className="mr-2 h-4 w-4" />
                Add Webhook
              </Button>
              <Button variant="outline" size="sm" onClick={() => openCreate('email')}>
                <Mail className="mr-2 h-4 w-4" />
                Add Email
              </Button>
              <Button variant="outline" size="sm" onClick={() => openCreate('jira')}>
                <Ticket className="mr-2 h-4 w-4" />
                Add Jira
              </Button>
              <Button variant="outline" size="sm" onClick={() => openCreate('linear')}>
                <ClipboardList className="mr-2 h-4 w-4" />
                Add Linear
              </Button>
            </div>
          </div>

          {destinations.length === 0 && (
            <EmptyState
              icon={Webhook}
              title="No alert destinations"
              description="Create a Slack webhook, Telegram bot, or generic webhook destination, then attach rules to it."
            />
          )}

          {(['slack', 'telegram', 'webhook', 'email', 'jira', 'linear'] as const).map(channel => (
            <div key={channel} className="space-y-3">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-medium capitalize">{channel}</h4>
                <Badge variant="outline" className="text-[10px]">
                  {groupedDestinations[channel].length}
                </Badge>
              </div>
              {groupedDestinations[channel].map(destination => (
                <div key={destination.id}>
                  <DestinationCard
                    slug={slug}
                    destination={destination}
                    eventTypes={eventTypes}
                    events={events}
                    onEditDestination={openEdit}
                  />
                  <div className="mt-2 flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => handleDeleteDestination(destination)}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete destination
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="min-w-0 space-y-4">
          <Panel title="Inbox" subtitle={`${inbox?.total ?? 0} groups`}>
            <div className="space-y-3 p-4">
              {!inbox || inbox.items.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No correlated alert groups.
                </div>
              ) : (
                <div className="space-y-2">
                  {inbox.items.map(group => (
                    <div key={group.correlation_group_id} className="rounded-md border p-3 text-xs">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={group.status === 'false_positive' ? 'destructive' : group.status === 'resolved' ? 'secondary' : 'outline'} className="text-[10px]">
                              {group.status}
                            </Badge>
                            <span className="font-medium">{group.item_count} items</span>
                            <span className="text-muted-foreground">
                              {new Date(group.latest_delivery_at).toLocaleString()}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-muted-foreground" title={group.scope_names.join(', ')}>
                            {group.scope_names.join(', ')}
                          </div>
                          <div className="mt-1 truncate text-[10px] text-muted-foreground">
                            {group.rule_names.join(', ')} · {group.scan_names.join(', ')}
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap justify-end gap-1">
                          {group.status === 'resolved' || group.status === 'false_positive' ? (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={inboxActionMut.isPending} onClick={() => inboxActionMut.mutate({ group, action: 'reopen' })}>
                              Reopen
                            </Button>
                          ) : (
                            <>
                              {group.status === 'open' && (
                                <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={inboxActionMut.isPending} onClick={() => inboxActionMut.mutate({ group, action: 'acknowledge' })}>
                                  Ack
                                </Button>
                              )}
                              <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={inboxActionMut.isPending} onClick={() => inboxActionMut.mutate({ group, action: 'resolve' })}>
                                Resolve
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={inboxActionMut.isPending} onClick={() => inboxActionMut.mutate({ group, action: 'mute' })}>
                                Mute
                              </Button>
                              <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={inboxActionMut.isPending} onClick={() => inboxActionMut.mutate({ group, action: 'false_positive' })}>
                                False positive
                              </Button>
                              {group.status !== 'open' && (
                                <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" disabled={inboxActionMut.isPending} onClick={() => inboxActionMut.mutate({ group, action: 'reopen' })}>
                                  Reopen
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {group.muted_until && (
                        <div className="mt-2 text-[10px] text-muted-foreground">
                          muted until {new Date(group.muted_until).toLocaleString()}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {inboxActionMut.isError && (
                <p role="alert" className="text-xs text-destructive">{getErrorMessage(inboxActionMut.error)}</p>
              )}
            </div>
          </Panel>

          <Panel title="Audit" subtitle={`${deliveries?.total ?? 0} deliveries`}>
            <div className="min-w-0 space-y-4 p-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="filter-status">Status</Label>
                  <Select value={deliveryFilters.status || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, status: value === 'all' ? '' : value }))}>
                    <SelectTrigger id="filter-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="sent">Sent</SelectItem>
                      <SelectItem value="failed">Failed</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="filter-channel">Channel</Label>
                  <Select value={deliveryFilters.channel || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, channel: value === 'all' ? '' : value }))}>
                    <SelectTrigger id="filter-channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="slack">Slack</SelectItem>
                      <SelectItem value="telegram">Telegram</SelectItem>
                      <SelectItem value="webhook">Webhook</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="jira">Jira</SelectItem>
                      <SelectItem value="linear">Linear</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="filter-destination">Destination</Label>
                  <Select value={deliveryFilters.destination_id || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, destination_id: value === 'all' ? '' : value, rule_id: '' }))}>
                    <SelectTrigger id="filter-destination"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      {destinations.map(destination => (
                        <SelectItem key={destination.id} value={destination.id}>
                          {destination.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="filter-rule">Rule</Label>
                  <Select value={deliveryFilters.rule_id || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, rule_id: value === 'all' ? '' : value }))}>
                    <SelectTrigger id="filter-rule"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      {allRules
                        .filter(rule => !deliveryFilters.destination_id || rule.destination_id === deliveryFilters.destination_id)
                        .map(rule => (
                          <SelectItem key={rule.id} value={rule.id}>
                            {rule.destination_name} / {rule.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="filter-scan">Scan</Label>
                  <Select value={deliveryFilters.scan_config_id || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, scan_config_id: value === 'all' ? '' : value }))}>
                    <SelectTrigger id="filter-scan"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      {scans.map(scan => (
                        <SelectItem key={scan.id} value={scan.id}>
                          {scan.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {!deliveries || deliveries.items.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No deliveries yet.
                </div>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Destination</TableHead>
                        <TableHead>Rule</TableHead>
                        <TableHead>Scan</TableHead>
                        <TableHead>Count</TableHead>
                        <TableHead>Channel</TableHead>
                        <TableHead>Error / Preview</TableHead>
                        <TableHead className="w-8"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deliveries.items.map(delivery => (
                        <AlertDeliveryRow key={delivery.id} slug={slug} delivery={delivery} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </Panel>
        </div>
      </div>

      <Dialog open={!!createType || !!editingDestination} onOpenChange={open => { if (!open) closeDestinationDialog() }}>
        <DialogContent className="max-w-lg">
          <form onSubmit={event => { event.preventDefault(); destinationMutation.mutate() }}>
            <DialogHeader>
              <DialogTitle>{editingDestination ? 'Edit Destination' : `New ${activeDestinationType === 'slack' ? 'Slack' : activeDestinationType === 'telegram' ? 'Telegram' : activeDestinationType === 'email' ? 'Email' : activeDestinationType === 'jira' ? 'Jira' : activeDestinationType === 'linear' ? 'Linear' : 'Webhook'} Destination`}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="dest-name">Name</Label>
                  <Input
                    id="dest-name"
                    value={destinationForm.name}
                    onChange={event => setDestinationForm(current => ({ ...current, name: event.target.value }))}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="dest-channel">Channel</Label>
                  <Select
                    value={destinationForm.type}
                    onValueChange={value => setDestinationForm(current => ({ ...defaultDestinationForm(value as DestinationChannel), name: current.name }))}
                    disabled={!!editingDestination}
                  >
                    <SelectTrigger id="dest-channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="slack">Slack</SelectItem>
                      <SelectItem value="telegram">Telegram</SelectItem>
                      <SelectItem value="webhook">Webhook</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                      <SelectItem value="jira">Jira</SelectItem>
                      <SelectItem value="linear">Linear</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {destinationForm.type === 'slack' ? (
                <div className="grid gap-2">
                  <Label htmlFor="dest-webhook-url">Webhook URL</Label>
                  <Input
                    id="dest-webhook-url"
                    type="password"
                    placeholder={editingDestination?.webhook_set ? 'Leave empty to keep current webhook' : 'https://hooks.slack.com/...'}
                    value={destinationForm.webhook_url}
                    onChange={event => setDestinationForm(current => ({ ...current, webhook_url: event.target.value }))}
                    required={!editingDestination || !editingDestination.webhook_set}
                  />
                </div>
              ) : destinationForm.type === 'telegram' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="dest-bot-token">Bot Token</Label>
                    <Input
                      id="dest-bot-token"
                      type="password"
                      placeholder={editingDestination?.bot_token_set ? 'Leave empty to keep current token' : '123456:ABC...'}
                      value={destinationForm.bot_token}
                      onChange={event => setDestinationForm(current => ({ ...current, bot_token: event.target.value }))}
                      required={!editingDestination || !editingDestination.bot_token_set}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="dest-chat-id">Chat ID</Label>
                    <Input
                      id="dest-chat-id"
                      value={destinationForm.chat_id}
                      onChange={event => setDestinationForm(current => ({ ...current, chat_id: event.target.value }))}
                      required
                    />
                  </div>
                </div>
              ) : destinationForm.type === 'webhook' ? (
                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="dest-target-url">Target URL</Label>
                    <Input
                      id="dest-target-url"
                      placeholder={editingDestination?.target_url_set ? 'Leave empty to keep current URL' : 'https://example.com/webhook'}
                      value={destinationForm.target_url}
                      onChange={event => setDestinationForm(current => ({ ...current, target_url: event.target.value }))}
                      required={!editingDestination || !editingDestination.target_url_set}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="dest-header-name">Secret Header Name</Label>
                      <Input
                        id="dest-header-name"
                        placeholder="Authorization (optional)"
                        value={destinationForm.webhook_header_name}
                        onChange={event => setDestinationForm(current => ({ ...current, webhook_header_name: event.target.value }))}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="dest-header-value">Secret Header Value</Label>
                      <Input
                        id="dest-header-value"
                        type="password"
                        placeholder={editingDestination?.webhook_header_name ? 'Leave empty to keep current value' : 'Bearer … (optional)'}
                        value={destinationForm.webhook_header_value}
                        onChange={event => setDestinationForm(current => ({ ...current, webhook_header_value: event.target.value }))}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Alerts POST a JSON payload (project, rule, scan, message, items). The optional secret header is sent with every request — use it for auth (e.g. Authorization).
                  </p>
                </div>
              ) : destinationForm.type === 'email' ? (
                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="dest-email-recipients">Recipients</Label>
                    <Input
                      id="dest-email-recipients"
                      placeholder="alice@example.com, bob@example.com"
                      value={destinationForm.email_recipients}
                      onChange={event => setDestinationForm(current => ({ ...current, email_recipients: event.target.value }))}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="dest-email-from">From Address (optional)</Label>
                      <Input
                        id="dest-email-from"
                        placeholder="alerts@tripl.example (defaults to SMTP_FROM_ADDRESS)"
                        value={destinationForm.email_from_address}
                        onChange={event => setDestinationForm(current => ({ ...current, email_from_address: event.target.value }))}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="dest-email-subject">Subject Template (optional)</Label>
                      <Input
                        id="dest-email-subject"
                        placeholder="[${'$'}{project_name}] ${'$'}{rule_name}"
                        value={destinationForm.email_subject_template}
                        onChange={event => setDestinationForm(current => ({ ...current, email_subject_template: event.target.value }))}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    SMTP settings (host/port/credentials) come from the instance config. Recipients are comma-separated. Subject supports {`\${project_name}`}, {`\${rule_name}`}, {`\${destination_name}`}, {`\${matched_count}`}.
                  </p>
                </div>
              ) : destinationForm.type === 'jira' ? (
                <div className="grid gap-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="dest-jira-base-url">Base URL</Label>
                      <Input
                        id="dest-jira-base-url"
                        placeholder="https://acme.atlassian.net"
                        value={destinationForm.jira_base_url}
                        onChange={event => setDestinationForm(current => ({ ...current, jira_base_url: event.target.value }))}
                        required={!editingDestination}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="dest-jira-auth-email">Auth Email</Label>
                      <Input
                        id="dest-jira-auth-email"
                        placeholder="alice@example.com"
                        value={destinationForm.jira_auth_email}
                        onChange={event => setDestinationForm(current => ({ ...current, jira_auth_email: event.target.value }))}
                        required={!editingDestination}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="dest-jira-api-token">API Token</Label>
                    <Input
                      id="dest-jira-api-token"
                      type="password"
                      placeholder={editingDestination?.jira_api_token_set ? 'Leave empty to keep current token' : 'Atlassian API token'}
                      value={destinationForm.jira_api_token}
                      onChange={event => setDestinationForm(current => ({ ...current, jira_api_token: event.target.value }))}
                      required={!editingDestination || !editingDestination.jira_api_token_set}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="dest-jira-project-key">Project Key</Label>
                      <Input
                        id="dest-jira-project-key"
                        placeholder="ENG"
                        value={destinationForm.jira_project_key}
                        onChange={event => setDestinationForm(current => ({ ...current, jira_project_key: event.target.value.toUpperCase() }))}
                        required={!editingDestination}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="dest-jira-issue-type">Issue Type</Label>
                      <Input
                        id="dest-jira-issue-type"
                        placeholder="Task"
                        value={destinationForm.jira_issue_type}
                        onChange={event => setDestinationForm(current => ({ ...current, jira_issue_type: event.target.value }))}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Each delivery opens a new issue in the project via Jira REST API v3 with Basic auth (email + API token). Body is rendered as ADF.
                  </p>
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor="dest-linear-api-key">API Key</Label>
                    <Input
                      id="dest-linear-api-key"
                      type="password"
                      placeholder={editingDestination?.linear_api_key_set ? 'Leave empty to keep current key' : 'lin_api_…'}
                      value={destinationForm.linear_api_key}
                      onChange={event => setDestinationForm(current => ({ ...current, linear_api_key: event.target.value }))}
                      required={!editingDestination || !editingDestination.linear_api_key_set}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label htmlFor="dest-linear-team-id">Team ID</Label>
                      <Input
                        id="dest-linear-team-id"
                        placeholder="team-uuid or short id"
                        value={destinationForm.linear_team_id}
                        onChange={event => setDestinationForm(current => ({ ...current, linear_team_id: event.target.value }))}
                        required={!editingDestination}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="dest-linear-state-id">State ID (optional)</Label>
                      <Input
                        id="dest-linear-state-id"
                        placeholder="state-uuid"
                        value={destinationForm.linear_state_id}
                        onChange={event => setDestinationForm(current => ({ ...current, linear_state_id: event.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="dest-linear-label-ids">Label IDs (optional, comma-separated)</Label>
                    <Input
                      id="dest-linear-label-ids"
                      placeholder="label-1, label-2"
                      value={destinationForm.linear_label_ids}
                      onChange={event => setDestinationForm(current => ({ ...current, linear_label_ids: event.target.value }))}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Each delivery opens a new issue in the team via Linear's GraphQL <code>issueCreate</code>. Use API key from Linear settings → API.
                  </p>
                </div>
              )}

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={destinationForm.enabled}
                  onCheckedChange={checked => setDestinationForm(current => ({ ...current, enabled: !!checked }))}
                />
                Destination enabled
              </label>

              {destinationMutation.isError && (
                <p className="text-sm text-destructive">{getErrorMessage(destinationMutation.error)}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDestinationDialog}>Cancel</Button>
              <Button type="submit" disabled={destinationMutation.isPending}>
                {editingDestination ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
