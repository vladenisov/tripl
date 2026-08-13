/**
 * Capability-aware product tour model (tripl-2su6.9).
 *
 * A concise guided path through the product's core surfaces. Each step links to
 * the REAL surface (deep link, slug-parameterised) so the tour is a launchpad,
 * not a slideshow. Kept as pure data so the ordering, coverage and links are
 * unit-testable without rendering.
 */

export interface TourStep {
  id: string
  /**
   * Grouped-nav area this surface belongs to. It must be one of the group
   * labels `buildNavGroups` actually renders — Plan, Observe or Govern. The
   * tour prints this as the step's chip, so a name the sidebar does not have
   * sends the reader looking for a group that does not exist; 'Connect' was
   * exactly that (tripl-3y7z).
   */
  area: string
  title: string
  blurb: string
  /** Deep link to the real surface for this step. */
  to: string
}

/**
 * The metric building blocks a newcomer must be able to reach directly from the
 * welcome flow. Each is a REAL deep link — the three catalog kinds
 * (fact / sql / event_composition) open the catalog already filtered to that
 * kind, event volume opens the Events catalog where the per-event series lives,
 * and fact tables open their own tab. They previously all pointed at a bare
 * /metrics, so the links existed but discovered nothing (tripl-2su6.19).
 *
 * Note "the four metric kinds" in the original acceptance is a miscount: the
 * backend MetricKind enum has three members. Event volume is a scan-collected
 * per-event series, not a MetricDefinition kind.
 */
export interface MetricBuildingBlock {
  id: string
  label: string
  blurb: string
  to: string
}

export function buildMetricBuildingBlocks(slug: string): MetricBuildingBlock[] {
  const metrics = `/p/${slug}/metrics`
  return [
    {
      // Event volume is NOT a catalog metric kind — MetricKind is only
      // fact/sql/event_composition. It is the per-event volume series a scan
      // collects, and it lives on the Events catalog, so that is where this
      // block points. Sending it to /metrics (as it used to) dropped the user on
      // a page that does not contain the thing being described.
      id: 'event-count',
      label: 'Event volume',
      blurb: 'How often each event fires over time — collected per event by a scan.',
      to: `/p/${slug}/events`,
    },
    {
      id: 'fact',
      label: 'Fact',
      blurb: 'Aggregate a numeric column from a fact table.',
      to: `${metrics}?kind=fact`,
    },
    {
      id: 'sql',
      label: 'SQL',
      blurb: 'A metric defined by a custom SQL query.',
      to: `${metrics}?kind=sql`,
    },
    {
      id: 'event_composition',
      label: 'Event composition',
      blurb: 'Ratios and per-user metrics composed from events.',
      to: `${metrics}?kind=event_composition`,
    },
    {
      id: 'fact-tables',
      label: 'Fact tables',
      blurb: 'The warehouse tables that fact & SQL metrics read from.',
      to: `${metrics}/fact-tables`,
    },
  ]
}

export function buildTourSteps(slug: string): TourStep[] {
  const base = `/p/${slug}`
  return [
    {
      id: 'events',
      area: 'Plan',
      title: 'Events & tracking plan',
      blurb: 'The catalog of events you track and their implementation status.',
      to: `${base}/events`,
    },
    {
      id: 'scans',
      // Scans live under Govern in the sidebar, and every doc says
      // "Govern → Scans". 'Connect' named no group at all.
      area: 'Govern',
      title: 'Scans',
      // A scan is not "pull volume to learn a baseline": that describes only the
      // scheduled metrics collection of a monitoring scan. What EVERY scan does
      // is fill the tracking plan (tripl-3y7z).
      blurb:
        'Read your warehouse into the tracking plan. Catalog + monitoring also records metric points on a schedule.',
      to: `${base}/scans`,
    },
    {
      id: 'live-activity',
      area: 'Observe',
      title: 'Live activity',
      // "as scans ... run" counted an execution as a scan, the same slip the
      // activity rail's burst summary made. An execution is a *run*.
      blurb: 'The Overview updates live as scan runs and metric collection land.',
      to: `${base}/overview`,
    },
    {
      id: 'metrics',
      area: 'Observe',
      title: 'Metrics & fact tables',
      blurb: 'Event-volume, fact, SQL and event-composition metrics, plus the fact tables behind them.',
      to: `${base}/metrics`,
    },
    {
      id: 'monitors',
      area: 'Observe',
      title: 'Monitors',
      blurb: 'The rules that decide which spikes and drops are worth notifying about, and their live state.',
      // The section, not the standalone page: that page rendered these same
      // rules under a second noun and was merged in (tripl-89ps). `/monitors`
      // would still resolve, but only through a redirect.
      to: `${base}/settings/alerting?section=monitors`,
    },
    {
      id: 'anomalies',
      area: 'Observe',
      title: 'Anomalies',
      blurb: 'Detected anomalies across the project with severity and direction.',
      to: `${base}/anomalies`,
    },
    {
      id: 'coverage',
      area: 'Govern',
      title: 'Coverage',
      blurb: 'Which platforms and event types are actually reporting.',
      to: `${base}/coverage`,
    },
    {
      id: 'reconciliation',
      area: 'Govern',
      title: 'Reconciliation',
      blurb: 'Which planned events are actually arriving vs the plan.',
      to: `${base}/reconciliation`,
    },
    {
      id: 'branches',
      area: 'Govern',
      title: 'Branches',
      blurb: 'Propose and review changes to the tracking plan on a branch.',
      to: `${base}/settings/branches`,
    },
    {
      id: 'alerting',
      area: 'Govern',
      title: 'Alert preview',
      blurb: 'Route anomalies to destinations and preview a simulated firing.',
      to: `${base}/settings/alerting`,
    },
    {
      id: 'search',
      area: 'Observe',
      title: 'Search by meaning',
      blurb:
        'Press Ctrl K (or ⌘K) and try "purchase funnel" or "money back" — semantic matches are marked.',
      to: `${base}/overview`,
    },
  ]
}
