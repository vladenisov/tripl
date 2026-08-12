import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { alertingApi } from '@/api/alerting'
import { eventTypesApi } from '@/api/eventTypes'
import { projectsApi } from '@/api/projects'
import { scansApi } from '@/api/scans'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useConfirm } from '@/hooks/useConfirm'
import type { AlertDestination, AlertInboxGroup } from '@/types'

import { AlertAuditPanel, type DeliveryFilters } from './alerting/AlertAuditPanel'
import { AlertingGuidedSetup } from './alerting/AlertingGuidedSetup'
import { AlertingInbox, type InboxAction } from './alerting/AlertingInbox'
import { DestinationsSection } from './alerting/DestinationsSection'
import { CHANNEL_META } from './alerting/channelMeta'
import { PageHead, Panel } from '@/components/settings/kit'
import {
  defaultDestinationForm,
  type DestinationChannel,
  type DestinationFormState,
} from './alerting/constants'
import { getErrorMessage } from '@/lib/utils'

// The page does three unrelated jobs — configure routing, triage incidents,
// audit delivery — and stacking them on one scroll made each of them harder to
// find (tripl-er99). Rules are deliberately NOT a fourth section: a rule hangs
// off `destination.rules` and its editor lives inside DestinationCard, so
// "rules" has no existence apart from the destination that owns it.
const ALERTING_SECTIONS = ['inbox', 'destinations', 'audit'] as const
type AlertingSection = (typeof ALERTING_SECTIONS)[number]

const SECTION_LABELS: Record<AlertingSection, string> = {
  inbox: 'Inbox',
  destinations: 'Destinations & rules',
  audit: 'Audit',
}

export default function ProjectAlertingTab({ slug, focusDeliveryId, focusItemKey, focusScanId, focusIncidentId }: { slug: string; focusDeliveryId?: string; focusItemKey?: string; focusScanId?: string; focusIncidentId?: string }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [createType, setCreateType] = useState<DestinationChannel | null>(null)
  const [destinationForm, setDestinationForm] = useState<DestinationFormState>(defaultDestinationForm('slack'))
  const [editingDestination, setEditingDestination] = useState<AlertDestination | null>(null)
  const [deliveryFilters, setDeliveryFilters] = useState<DeliveryFilters>({
    status: '',
    channel: '',
    destination_id: '',
    rule_id: '',
    // Seeded from `?scan=` so a scan run's "Alerts queued" counter can hand the
    // audit log over already narrowed to that scan (tripl-3y7z.2).
    scan_config_id: focusScanId ?? '',
  })
  // `?scan=` can change without remounting (the alerting route is one page, and
  // navigating from a deep link back to plain /alerting only swaps the query
  // string), so the seed above fires once and would then go stale. Adjusting
  // during render is React's documented way to follow a prop; an effect would
  // fire one request against the old filter first.
  const [appliedScanFocus, setAppliedScanFocus] = useState(focusScanId)
  if (focusScanId !== appliedScanFocus) {
    setAppliedScanFocus(focusScanId)
    setDeliveryFilters(current => ({ ...current, scan_config_id: focusScanId ?? '' }))
  }

  // Section lives in a QUERY param, not a path segment. The second segment of
  // /p/:slug/settings/:tab/:itemId is the delivery id an alert link carries, and
  // it is the only linkable shape the backend can emit — urls.py returns no link
  // at all without one — so a section name there would collide with every link
  // already sitting in someone's Telegram history.
  //
  // Declared above the queries because several of them are gated on it: a
  // section that is not on screen should not cost a request.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedSection = searchParams.get('section')
  const section: AlertingSection = (ALERTING_SECTIONS as readonly string[]).includes(
    requestedSection ?? '',
  )
    ? (requestedSection as AlertingSection)
    // No explicit section: land where the link can actually be answered. An
    // alert names its incident; an older one names only its delivery. An
    // unknown value degrades to the default rather than rendering nothing,
    // matching how `?scan=` is already treated below.
    : focusIncidentId
      ? 'inbox'
      : focusDeliveryId || focusScanId
        ? 'audit'
        : 'inbox'
  const selectSection = (next: AlertingSection) =>
    setSearchParams(
      current => {
        const params = new URLSearchParams(current)
        params.set('section', next)
        return params
      },
      { replace: true },
    )

  const { data: destinations = [] } = useQuery({
    queryKey: ['alertDestinations', slug],
    queryFn: () => alertingApi.listDestinations(slug),
  })
  const { data: project } = useQuery({
    queryKey: ['project', slug],
    queryFn: () => projectsApi.get(slug),
  })
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug),
    // Read only by the rule editor inside a destination card.
    enabled: section === 'destinations',
  })
  const { data: scans = [], isSuccess: scansLoaded } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })
  // A `?scan=` naming a scan this project does not have (deleted since the link
  // was written, or hand-edited) reads as "All" rather than as a permanently
  // empty audit log — the same degradation AnomaliesPage applies to its facet.
  // Gated on `scansLoaded` so a valid filter is not dropped during the in-flight
  // window when `scans` is still the `[]` default.
  const scanFilterIsKnown =
    !scansLoaded || scans.some(scan => scan.id === deliveryFilters.scan_config_id)
  const activeDeliveryFilters = scanFilterIsKnown
    ? deliveryFilters
    : { ...deliveryFilters, scan_config_id: '' }
  const { data: deliveries } = useQuery({
    queryKey: ['alertDeliveries', slug, activeDeliveryFilters],
    queryFn: () => alertingApi.listDeliveries(slug, {
      ...activeDeliveryFilters,
      status: activeDeliveryFilters.status || undefined,
      channel: activeDeliveryFilters.channel || undefined,
      destination_id: activeDeliveryFilters.destination_id || undefined,
      rule_id: activeDeliveryFilters.rule_id || undefined,
      scan_config_id: activeDeliveryFilters.scan_config_id || undefined,
      limit: 50,
      offset: 0,
    }),
    // Audit is the only reader — the pinned deep-linked row and the table. It
    // was left ungated because it used to feed the guided-setup gate too; that
    // now has its own unfiltered probe below, so nothing outside Audit needs it.
    enabled: section === 'audit',
  })
  // Has this project EVER delivered, asked WITHOUT the audit filters.
  //
  // The gate below decides whether the whole page collapses into guided setup,
  // and reading it off the filtered query made that a trap: on a project whose
  // destinations were deleted but whose delivery history remains, an audit
  // filter matching nothing drove `total` to 0, the page replaced itself with
  // the setup checklist — and the filter bar that caused it went with it, so
  // there was nothing left to undo. One row is enough to answer the question.
  const { data: everDelivered } = useQuery({
    queryKey: ['alertDeliveriesAny', slug],
    queryFn: () => alertingApi.listDeliveries(slug, { limit: 1 }),
  })
  // A deep link from an alert message names ONE delivery, and that delivery
  // may be older than the 50 rows the audit list carries or excluded by the
  // active filters. Fetching it by id and pinning it above the list is what
  // makes the link outlive the list: without this the reader lands on an audit
  // page that does not contain the row the message told them to look at.
  const { data: focusedDelivery } = useQuery({
    queryKey: ['alertDelivery', slug, focusDeliveryId],
    queryFn: () => alertingApi.getDelivery(slug, focusDeliveryId!),
    // Audit is the only section that renders it, so it is not worth a request
    // while the reader is on another one.
    enabled: !!focusDeliveryId && section === 'audit',
  })
  const pinnedDelivery = focusedDelivery
    && !deliveries?.items.some(item => item.id === focusedDelivery.id)
    ? focusedDelivery
    : null
  const { data: inbox } = useQuery({
    queryKey: ['alertInbox', slug],
    queryFn: () => alertingApi.listInbox(slug, { limit: 20 }),
    // Only the Inbox section reads this. Splitting the page is what makes the
    // saving possible — before it, every section was on screen at once.
    enabled: section === 'inbox',
  })

  const allRules = destinations.flatMap(destination =>
    destination.rules.map(rule => ({
      ...rule,
      destination_name: destination.name,
      destination_id: destination.id,
    })))

  const createDestinationMut = useMutation({
    mutationFn: () => {
      // The demo-only ``demo_sink`` is created by the seeder, never here — so the
      // create payload always carries a real ``DestinationChannel``. Narrow the
      // widened form type explicitly rather than casting.
      const { type } = destinationForm
      if (type === 'demo_sink') {
        throw new Error('The local demo sink cannot be created from the UI')
      }
      return alertingApi.createDestination(slug, { ...destinationForm, type })
    },
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

  // Draft note per group. The backend has accepted a note on every inbox action
  // since the feature shipped, but nothing ever sent one — the field was
  // unreachable, so an operator had no way to record WHY they acked something
  // (tripl-jfm3.91). Omitting the key leaves the stored note untouched.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  // An alert link names its incident, so the card it points at opens with its
  // deliveries already showing — the reader lands on the alert AND the actions
  // for it, instead of on a delivery whose incident is in another list further
  // up the page (tripl-pq97). Seeded once: collapsing it must stick.
  const [expandedIncidents, setExpandedIncidents] = useState<Set<string>>(
    () => new Set(focusIncidentId ? [focusIncidentId] : []),
  )
  const toggleIncident = (correlationGroupId: string) =>
    setExpandedIncidents(current => {
      const next = new Set(current)
      if (!next.delete(correlationGroupId)) next.add(correlationGroupId)
      return next
    })

  const inboxActionMut = useMutation({
    mutationFn: ({
      group,
      action,
    }: {
      group: AlertInboxGroup
      action: InboxAction
    }) => {
      const mutedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString()
      const draft = (noteDrafts[group.correlation_group_id] ?? '').trim()
      return alertingApi.applyInboxAction(slug, group.correlation_group_id, {
        action,
        ...(draft ? { note: draft } : {}),
        ...(action === 'mute' ? { muted_until: mutedUntil } : {}),
      })
    },
    onSuccess: (_data, variables) => {
      // The draft has been persisted server-side; drop it so the input goes
      // back to showing the placeholder rather than a stale copy.
      setNoteDrafts(current => {
        const rest = { ...current }
        delete rest[variables.group.correlation_group_id]
        return rest
      })
      qc.invalidateQueries({ queryKey: ['alertInbox', slug] })
      qc.invalidateQueries({ queryKey: ['alertDeliveries', slug] })
      qc.invalidateQueries({ queryKey: ['scans', slug] })
    },
  })
  const activeDestinationType = editingDestination?.type ?? createType ?? destinationForm.type

  const hasDestinations = destinations.length > 0
  const hasRules = allRules.length > 0
  // Delivery history means alerts have fired before, so the project is NOT a
  // blank slate even if its destinations/rules were later removed — keep the
  // normal view (with the Audit log) rather than collapsing to guided setup.
  const hasDeliveries = (everDelivered?.total ?? 0) > 0
  // Before anything is configured, collapse the three empty boxes (routing
  // rules, destinations, inbox) into one guided flow. The Inbox card also stays
  // hidden until a rule exists, so it never shows an empty group before the
  // first rule can produce one.
  const showGuidedSetup = !hasDestinations && !hasRules && !hasDeliveries
  // A demo workspace is zero-egress: the API accepts no destination but the local
  // demo sink, so offering the channel buttons would only walk the user into a
  // rejection. Say why instead (tripl-2su6.12).
  const isDemo = project?.is_demo === true

  return (
    <div className="space-y-6">
      {dialog}
      <PageHead
        eyebrow="Observe"
        title="Alerting"
        // A demo can only reach the local sink, so promising Slack/Telegram
        // delivery at the top of the page sells something this project cannot
        // do — the honest note used to appear only below the destination cards
        // (tripl-jfm3.64).
        description={
          isDemo
            ? 'Route active anomaly signals through rules and destinations. In a demo workspace every destination is a local sink: deliveries are recorded and rendered here, and none of them leave this instance.'
            : 'Route active anomaly signals to Slack, Telegram, or a generic webhook. Rules are project-level and apply to every scan in the project.'
        }
      />

      {/* No tab strip while nothing is configured: with no destinations, no
          rules and no deliveries, two of the three sections are empty by
          construction, and offering them is three doors onto one room. */}
      {!showGuidedSetup && (
        <div
          className="flex flex-wrap items-center gap-1 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}
          role="tablist"
          aria-label="Alerting sections"
        >
          {ALERTING_SECTIONS.map(value => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={section === value}
              onClick={() => selectSection(value)}
              className="-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors"
              style={{
                borderColor: section === value ? 'var(--accent)' : 'transparent',
                color: section === value ? 'var(--fg)' : 'var(--fg-subtle)',
                fontWeight: section === value ? 600 : 400,
              }}
            >
              {SECTION_LABELS[value]}
            </button>
          ))}
        </div>
      )}

      {showGuidedSetup ? (
        <>
          <AlertingGuidedSetup channels={CHANNEL_META} onPickChannel={openCreate} />
          {/* Keep the Audit log reachable before anything is configured so the
              surface stays discoverable. Guided state requires zero deliveries,
              so it is always empty here — render just the panel + empty state,
              without the (equally empty) filter bar (tripl-7l83.14). */}
          <Panel title="Audit" subtitle="0 deliveries">
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No deliveries yet.
            </div>
          </Panel>
        </>
      ) : (
      <>
      {section === 'destinations' && (
        <DestinationsSection
          slug={slug}
          destinations={destinations}
          eventTypes={eventTypes}
          scans={scans}
          isDemo={isDemo}
          onCreateDestination={openCreate}
          onEditDestination={openEdit}
          onDeleteDestination={handleDeleteDestination}
        />
      )}

      {section === 'inbox' && (
        <AlertingInbox
          slug={slug}
          inbox={inbox}
          hasRules={hasRules}
          noteDrafts={noteDrafts}
          setNoteDrafts={setNoteDrafts}
          expandedIncidents={expandedIncidents}
          toggleIncident={toggleIncident}
          onAction={inboxActionMut.mutate}
          isActionPending={inboxActionMut.isPending}
          isActionError={inboxActionMut.isError}
          actionError={inboxActionMut.error}
          onGoToDestinations={() => selectSection('destinations')}
          focusDeliveryId={focusDeliveryId}
          focusItemKey={focusItemKey}
        />
      )}

      {section === 'audit' && (
        <AlertAuditPanel
          slug={slug}
          deliveries={deliveries}
          pinnedDelivery={pinnedDelivery}
          focusDeliveryId={focusDeliveryId}
          focusItemKey={focusItemKey}
          deliveryFilters={deliveryFilters}
          setDeliveryFilters={setDeliveryFilters}
          activeScanFilter={activeDeliveryFilters.scan_config_id}
          destinations={destinations}
          allRules={allRules}
          scans={scans}
        />
      )}
      </>
      )}

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
                        placeholder={`[\${project_name}] \${rule_name}`}
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
