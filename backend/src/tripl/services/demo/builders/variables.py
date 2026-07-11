"""Variables builder: the templating layer.

Seeds the project variables, their *observed* value contexts (what the scan
pipeline would discover), and one *authored* per-event override — a
``VariableEventValueOverride`` documenting the allowed values for a variable in
one event's context. Both the observed contexts and the authored override are
reachable through the variables API.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.models.variable_value import VariableValue, VariableValueKind
from tripl.services.demo.scenario import DemoContext

# (name, source_name, variable_type, description)
_VARIABLE_SPECS: tuple[tuple[str, str, str, str], ...] = (
    ("user_id", "user_id", "string", "Unique identifier for the authenticated user."),
    ("session_id", "session_id", "string", "Session identifier scoped to one app launch."),
    ("product_id", "product_id", "string", "Store product / SKU identifier."),
)


async def build_variables(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_variables(session, ctx)
    await _build_observed_values(session, ctx)
    await _build_authored_override(session, ctx)


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
