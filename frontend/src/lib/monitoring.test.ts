import { describe, expect, it } from 'vitest'
import {
  formatSignalSeverity,
  getMetricMonitoringPath,
  getMonitoringPath,
  getScopeMonitoringPath,
  getScopeNavigationTarget,
  resolveDetailScope,
  routeScopeToApiScope,
} from './monitoring'

describe('routeScopeToApiScope', () => {
  it('maps the known route scopes to their API scope', () => {
    expect(routeScopeToApiScope('project-total')).toBe('project_total')
    expect(routeScopeToApiScope('event-type')).toBe('event_type')
    expect(routeScopeToApiScope('event')).toBe('event')
    expect(routeScopeToApiScope('metric')).toBe('metric')
  })

  it('throws on truly-unknown scope strings', () => {
    expect(() => routeScopeToApiScope('bogus')).toThrow(/unknown monitoring scope/)
    expect(() => routeScopeToApiScope(undefined)).toThrow(/unknown monitoring scope/)
  })
})

describe('getMetricMonitoringPath', () => {
  it('builds the catalog-metric drilldown URL', () => {
    expect(getMetricMonitoringPath('demo', 'm-1')).toBe('/p/demo/monitoring/metric/m-1')
  })
})

describe('getMonitoringPath', () => {
  it('routes each scope with a detail page to that page', () => {
    expect(getMonitoringPath('demo', { scope_type: 'project_total', scope_ref: 'pt-1' })).toBe(
      '/p/demo/monitoring/project-total/pt-1',
    )
    expect(getMonitoringPath('demo', { scope_type: 'event_type', scope_ref: 'et-1' })).toBe(
      '/p/demo/monitoring/event-type/et-1',
    )
    expect(getMonitoringPath('demo', { scope_type: 'event', scope_ref: 'evt-1' })).toBe(
      '/p/demo/monitoring/event/evt-1',
    )
    expect(getMonitoringPath('demo', { scope_type: 'metric', scope_ref: 'm-1' })).toBe(
      '/p/demo/monitoring/metric/m-1',
    )
  })

  it('throws rather than guessing for the scopes with no detail route', () => {
    // Callers that must not link to a wrong page get a loud failure; the ones
    // merely deciding whether to offer a link use getScopeMonitoringPath.
    for (const scope of ['schema', 'distribution', 'release_regression', 'variable_value_drift'] as const) {
      expect(() => getMonitoringPath('demo', { scope_type: scope, scope_ref: 'x' })).toThrow(
        /no monitoring detail route/,
      )
    }
  })
})

describe('getScopeMonitoringPath', () => {
  it('routes a scope that has its own detail page there', () => {
    expect(
      getScopeMonitoringPath('demo', { scope_type: 'event', scope_ref: 'evt-1' }),
    ).toBe('/p/demo/monitoring/event/evt-1')
    expect(
      getScopeMonitoringPath('demo', { scope_type: 'metric', scope_ref: 'm-1' }),
    ).toBe('/p/demo/monitoring/metric/m-1')
  })

  it('answers with null instead of throwing where getMonitoringPath would throw', () => {
    // The whole point of this wrapper: a table cell asking "is there anywhere to
    // link?" must not have to wrap the call in a try.
    expect(
      getScopeMonitoringPath('demo', { scope_type: 'schema', scope_ref: 'field_a' }),
    ).toBeNull()
    expect(
      getScopeMonitoringPath('demo', { scope_type: 'distribution', scope_ref: 'field_a' }),
    ).toBeNull()
  })

  it('never links a release regression to the event page, even though it has an event_id (tripl-oxkt.21)', () => {
    // The deny-set case. A release regression compares a release cohort against
    // the previous release; the event page charts all versions against the
    // seasonal baseline, so it cannot corroborate the alert even in principle —
    // which is exactly why the backend builder (worker/tasks/metrics/urls.py)
    // refuses to emit this link. Note both fields are populated and a regression
    // scope_ref IS its event id, so nothing cheaper than an explicit deny would
    // have caught it: before the fix this returned the event page twice over.
    // Navigation to that event lives in `getScopeNavigationTarget` below
    // (tripl-wkwv.12) — deleting this deny-set entry restores nothing, it only
    // puts the contradicting link back.
    expect(
      getScopeMonitoringPath('demo', {
        scope_type: 'release_regression',
        scope_ref: 'evt-1',
        event_id: 'evt-1',
      }),
    ).toBeNull()
  })

  it('denies a release regression whose scope_ref is an event TYPE id', () => {
    // The event-type-scoped regression was the worse half of the same defect:
    // scope_ref is an event_type_id, so the old fallthrough emitted a
    // valid-looking /monitoring/event/{event_type_id} for a page that does not
    // exist.
    expect(
      getScopeMonitoringPath('demo', {
        scope_type: 'release_regression',
        scope_ref: 'et-1',
        event_id: null,
      }),
    ).toBeNull()
  })

  it('still resolves a variable-value drift through the event fallback', () => {
    // The fallback is not collateral damage of the deny-set: a drift scope has no
    // route of its own, but its event_id is NOT NULL and /monitoring/event/:id
    // mounts the panel that names the variable and lists its observed values.
    expect(
      getScopeMonitoringPath('demo', {
        scope_type: 'variable_value_drift',
        scope_ref: 'plan_tier',
        event_id: 'evt-9',
      }),
    ).toBe('/p/demo/monitoring/event/evt-9')
  })

  it('gives a drift scope no link at all when it carries no event', () => {
    // schema / distribution drift carry a null event_id, so they get nothing
    // rather than a guess — which at least does not mislead.
    expect(
      getScopeMonitoringPath('demo', {
        scope_type: 'schema',
        scope_ref: 'field_a',
        event_id: null,
      }),
    ).toBeNull()
  })
})

describe('getScopeNavigationTarget', () => {
  it('opens the event a release regression was found on (tripl-wkwv.12)', () => {
    // 30 of 123 incidents on the live instance were exactly this shape and
    // rendered their event name as dead text. The deny-set still refuses this
    // page as SUBSTANTIATION for a release-cohort comparison; this answers the
    // other question — "where do I go to look at the event it names?".
    expect(
      getScopeNavigationTarget('demo', {
        scope_type: 'release_regression',
        scope_ref: 'evt-1',
        event_id: 'evt-1',
      }),
    ).toEqual({ path: '/p/demo/monitoring/event/evt-1', scope: 'event' })
  })

  it('opens the event TYPE a release regression was found on', () => {
    // The other partition of the same detector, emitted on every scan with an
    // app version column. `event_id` is null and scope_ref is the event_type_id
    // (worker/tasks/metrics/regression.py), and /monitoring/event-type/:id is a
    // real page for exactly that id — so "the row carries no event" is a reason
    // to withhold the EVENT route, not a reason to leave the name dead text.
    // What tripl-oxkt.21 removed was /monitoring/event/{event_type_id}: the
    // wrong route for an id, not the absence of a destination.
    expect(
      getScopeNavigationTarget('demo', {
        scope_type: 'release_regression',
        scope_ref: 'et-1',
        event_id: null,
      }),
    ).toEqual({ path: '/p/demo/monitoring/event-type/et-1', scope: 'event_type' })
  })

  it('offers nothing for any scope getScopeMonitoringPath already routes', () => {
    // The complement property, asserted rather than assumed: a surface
    // rendering both helpers can never show two links to one page. The drift
    // row is the interesting one — it has no route of its own and reaches the
    // event page through the fallback, so a naive "has no detail route?"
    // implementation would double-link exactly there.
    const routed = [
      { scope_type: 'event', scope_ref: 'evt-1', event_id: 'evt-1' },
      { scope_type: 'event_type', scope_ref: 'et-1', event_id: null },
      { scope_type: 'project_total', scope_ref: 'pt-1', event_id: null },
      { scope_type: 'metric', scope_ref: 'm-1', event_id: null },
      { scope_type: 'variable_value_drift', scope_ref: 'plan_tier', event_id: 'evt-9' },
    ]
    for (const scope of routed) {
      expect(getScopeMonitoringPath('demo', scope)).not.toBeNull()
      expect(getScopeNavigationTarget('demo', scope)).toBeNull()
    }
  })

  it('offers nothing for a scope with neither a page nor an event', () => {
    // schema / distribution drift carry a null event_id: both questions have
    // the same answer here, and it is "nowhere". Gating the event-type branch on
    // the SCOPE TYPE rather than on "no event_id" is what keeps it that way —
    // these carry an event_type_id on the backend row too, but their scope_ref
    // is a field name, so reading it as an id would route `field_a` to an
    // event-type page that does not exist.
    expect(
      getScopeNavigationTarget('demo', {
        scope_type: 'schema',
        scope_ref: 'field_a',
        event_id: null,
      }),
    ).toBeNull()
    expect(
      getScopeNavigationTarget('demo', {
        scope_type: 'distribution',
        scope_ref: 'field_a',
        event_id: null,
      }),
    ).toBeNull()
  })
})

describe('formatSignalSeverity', () => {
  it('reads "dropped to zero" for a drop whose actual count bottomed out at zero', () => {
    // The detector clamps the z-score for these, so "z=-20.0" is repeated and
    // low-information; the useful fact is that the series went to zero.
    expect(
      formatSignalSeverity({
        actual_count: 0,
        expected_count: 80,
        z_score: -20,
        direction: 'drop',
      }),
    ).toBe('dropped to zero')
  })

  it('keeps the numeric z-score (prefix included) for a non-zero drop', () => {
    expect(
      formatSignalSeverity({
        actual_count: 40,
        expected_count: 100,
        z_score: -6,
        direction: 'drop',
      }),
    ).toBe('z=-6.0')
  })

  it('keeps the numeric z-score for a spike, even when it reads zero actuals', () => {
    // Only a `drop` to zero gets the special label; a spike never does.
    expect(
      formatSignalSeverity({
        actual_count: 0,
        expected_count: 10,
        z_score: 4.25,
        direction: 'spike',
      }),
    ).toBe('z=4.3')
  })
})

describe('resolveDetailScope', () => {
  it('defaults to the event scope for the legacy /events/detail route (no scope segment)', () => {
    // B1: the legacy URL carries an eventId but no :scope, which used to crash.
    expect(resolveDetailScope(undefined, 'event-1')).toBe('event')
  })

  it('honours an explicit scope segment over the eventId default', () => {
    expect(resolveDetailScope('project-total', 'event-1')).toBe('project_total')
    expect(resolveDetailScope('event-type', undefined)).toBe('event_type')
  })

  it('stays strict when neither a valid scope nor an eventId is present', () => {
    expect(() => resolveDetailScope(undefined, undefined)).toThrow(/unknown monitoring scope/)
    expect(() => resolveDetailScope('bogus', undefined)).toThrow(/unknown monitoring scope/)
  })
})
