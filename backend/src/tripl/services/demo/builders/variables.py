"""Variables builder: the templating layer.

Seeds the project variables, their *observed* value contexts (what the scan
pipeline would discover), one *authored* per-event override — a
``VariableEventValueOverride`` documenting the allowed values for a variable in
one event's context — and one OPEN ``VariableValueDrift``: a value observed
outside that documented list, so the variables drift UI (``list_value_drifts``,
the open-drift counts, the event drift badge) has a real row to show. It does
NOT feed the firing alert rule's replay: replay candidates come from
``MetricAnomaly`` plus the schema/distribution drift loaders, and the live
worker path filters on ``scan_config_id`` (``None`` here). All rows are
reachable through the variables API.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.schema_drift import SCHEMA_DRIFT_STATUS_OPEN
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.models.variable_value import VariableValue, VariableValueKind
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.services.demo.scenario import DemoContext

# (name, source_name, variable_type, description)
_VARIABLE_SPECS: tuple[tuple[str, str, str, str], ...] = (
    ("user_id", "user_id", "string", "Unique identifier for the authenticated user."),
    ("session_id", "session_id", "string", "Session identifier scoped to one app launch."),
    ("product_id", "product_id", "string", "Store product / SKU identifier."),
)


# The one value observed OUTSIDE the documented override list below — the
# seeded drift row. Kept module-level so tests can assert against the contract.
DRIFT_OBSERVED_VALUES = ["prod_weekly"]
# Detected recently (well inside the 30-day read-time retention window) and
# derived from ctx.now, so two seeds with the same clock produce identical rows.
_DRIFT_DETECTED_AGO = timedelta(hours=6)


async def build_variables(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_variables(session, ctx)
    await _build_observed_values(session, ctx)
    await _build_authored_override(session, ctx)
    await _build_value_drift(session, ctx)


async def _build_variables(session: AsyncSession, ctx: DemoContext) -> None:
    for name, source_name, variable_type, description in _VARIABLE_SPECS:
        var = Variable(
            project_id=ctx.project_id,
            branch_id=ctx.branch_id,
            name=name,
            source_name=source_name,
            variable_type=variable_type,
            description=description,
        )
        session.add(var)
        await session.flush()
        ctx.variable_ids[name] = var.id


async def _build_observed_values(session: AsyncSession, ctx: DemoContext) -> None:
    """Observed value contexts — the scan-discovered sample values per event/field."""
    observed = (
        # (variable, event, field_key, source_column, observed_count, values)
        (
            "user_id",
            "Home Screen View",
            "screen_view.screen_name",
            "user_id",
            14823,
            ["u_001", "u_002", "u_003", "u_004", "u_005"],
        ),
        (
            "product_id",
            "Purchase Completed",
            "purchase.product_id",
            "product_id",
            3241,
            ["prod_monthly", "prod_annual", "prod_lifetime"],
        ),
        (
            "session_id",
            "Paywall View",
            "screen_view.screen_name",
            "session_id",
            6102,
            ["sess_aaa", "sess_bbb", "sess_ccc"],
        ),
    )
    for var_name, event_name, field_key, source_column, observed_count, values in observed:
        session.add(
            VariableValue(
                project_id=ctx.project_id,
                branch_id=ctx.branch_id,
                variable_id=ctx.variable_ids[var_name],
                event_id=ctx.event_ids[event_name],
                field_definition_id=ctx.field_ids[field_key],
                source_column=source_column,
                value_kind=VariableValueKind.low.value,
                observed_count=observed_count,
                values=values,
            )
        )
    await session.flush()


async def _build_authored_override(session: AsyncSession, ctx: DemoContext) -> None:
    """One authored, documented per-event override (user-owned; not scan-written)."""
    session.add(
        VariableEventValueOverride(
            project_id=ctx.project_id,
            branch_id=ctx.branch_id,
            variable_id=ctx.variable_ids["product_id"],
            event_id=ctx.event_ids["Trial Started"],
            values=["prod_monthly", "prod_annual"],
        )
    )
    await session.flush()


async def _build_value_drift(session: AsyncSession, ctx: DemoContext) -> None:
    """One OPEN value drift: ``prod_weekly`` seen on Trial Started's product_id.

    Mirrors what the scan upsert would write when it observes a value outside
    the documented override list above. ``scan_config_id`` stays NULL — the
    warehouse builder (and its ScanConfig) runs after this one, and the column
    is nullable by design (``SET NULL`` on scan deletion). That NULL also means
    the scan worker's drift-candidate loader (which filters on its own
    ``scan_config_id``) never picks this row up, and rule replay builds its
    candidates from ``MetricAnomaly`` + schema/distribution drifts only — so
    the row surfaces exclusively in the variables drift UI, never in a firing.
    """
    session.add(
        VariableValueDrift(
            project_id=ctx.project_id,
            variable_id=ctx.variable_ids["product_id"],
            event_id=ctx.event_ids["Trial Started"],
            scan_config_id=None,
            observed_values=list(DRIFT_OBSERVED_VALUES),
            status=SCHEMA_DRIFT_STATUS_OPEN,
            detected_at=ctx.now - _DRIFT_DETECTED_AGO,
        )
    )
    await session.flush()
