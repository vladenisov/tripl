import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any, NamedTuple

import pytest
from httpx import AsyncClient
from sqlalchemy import create_engine
from sqlalchemy import event as sa_event
from sqlalchemy.orm import Session, sessionmaker

from tripl.models import Base
from tripl.models.data_source import DataSource
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.models.variable_value_drift import VariableValueDrift
from tripl.schemas.variable import SUMMARY_VALUE_LIMIT
from tripl.services import variable_retirement_service, variable_service
from tripl.services.variable_value_service import attach_variable_summaries
from tripl.tests.conftest import TestSessionLocal, engine
from tripl.worker.tasks.metrics.signals import _get_active_variable_value_drift_candidates


async def _setup_project(client: AsyncClient, slug: str = "var-proj"):
    await client.post("/api/v1/projects", json={"name": "VP", "slug": slug})


@pytest.mark.asyncio
async def test_create_variable(client: AsyncClient):
    await _setup_project(client, "var-create")
    resp = await client.post(
        "/api/v1/projects/var-create/variables",
        json={"name": "user_id", "variable_type": "string", "description": "User ID"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "user_id"
    assert data["variable_type"] == "string"
    assert data["description"] == "User ID"
    assert "id" in data


@pytest.mark.asyncio
async def test_create_variable_invalid_name(client: AsyncClient):
    await _setup_project(client, "var-invalid")
    resp = await client.post(
        "/api/v1/projects/var-invalid/variables",
        json={"name": "Invalid Name!", "variable_type": "string"},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_variable_duplicate(client: AsyncClient):
    await _setup_project(client, "var-dup")
    await client.post(
        "/api/v1/projects/var-dup/variables",
        json={"name": "dup_var", "variable_type": "number"},
    )
    resp = await client.post(
        "/api/v1/projects/var-dup/variables",
        json={"name": "dup_var", "variable_type": "string"},
    )
    assert resp.status_code in (400, 409)


@pytest.mark.asyncio
async def test_list_variables(client: AsyncClient):
    await _setup_project(client, "var-list")
    await client.post(
        "/api/v1/projects/var-list/variables",
        json={"name": "var_a", "variable_type": "string"},
    )
    await client.post(
        "/api/v1/projects/var-list/variables",
        json={"name": "var_b", "variable_type": "number"},
    )
    resp = await client.get("/api/v1/projects/var-list/variables")
    assert resp.status_code == 200
    assert resp.json()["total"] == 2
    assert len(resp.json()["items"]) == 2


@pytest.mark.asyncio
async def test_list_variables_honours_limit_and_offset(client: AsyncClient):
    await _setup_project(client, "var-page")
    for name in ("var_a", "var_b", "var_c"):
        await client.post(
            "/api/v1/projects/var-page/variables",
            json={"name": name, "variable_type": "string"},
        )

    first = await client.get("/api/v1/projects/var-page/variables?limit=1")
    assert first.status_code == 200
    assert first.json()["total"] == 3
    assert [item["name"] for item in first.json()["items"]] == ["var_a"]

    page_two = await client.get("/api/v1/projects/var-page/variables?limit=2&offset=1")
    assert page_two.status_code == 200
    assert page_two.json()["total"] == 3
    assert [item["name"] for item in page_two.json()["items"]] == ["var_b", "var_c"]

    past_end = await client.get("/api/v1/projects/var-page/variables?offset=99")
    assert past_end.status_code == 200
    assert past_end.json() == {"items": [], "total": 3}


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["limit=abc", "limit=-5", "limit=0", "offset=-1", "limit=999999"])
async def test_list_variables_rejects_invalid_paging(client: AsyncClient, query: str):
    await _setup_project(client, "var-page-bad")
    resp = await client.get(f"/api/v1/projects/var-page-bad/variables?{query}")
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_variable_responses_include_observed_value_summary(client: AsyncClient):
    await _setup_project(client, "var-values")
    et_resp = await client.post(
        "/api/v1/projects/var-values/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    event_type_id = et_resp.json()["id"]
    field_resp = await client.post(
        f"/api/v1/projects/var-values/event-types/{event_type_id}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    field_id = field_resp.json()["id"]
    variable_resp = await client.post(
        "/api/v1/projects/var-values/variables",
        json={"name": "user_id", "variable_type": "string"},
    )
    event_resp = await client.post(
        "/api/v1/projects/var-values/events",
        json={
            "event_type_id": event_type_id,
            "name": "Profile View",
            "field_values": [{"field_definition_id": field_id, "value": "${user_id}"}],
        },
    )
    variable_id = uuid.UUID(variable_resp.json()["id"])
    event_id = uuid.UUID(event_resp.json()["id"])

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, variable_id)
        event = await session.get(Event, event_id)
        assert variable is not None
        assert event is not None
        session.add(
            VariableValue(
                project_id=variable.project_id,
                branch_id=variable.branch_id,
                variable_id=variable.id,
                event_id=event.id,
                field_definition_id=uuid.UUID(field_id),
                source_column="user_id",
                value_kind="low",
                observed_count=2,
                values=["u1", "u2"],
            )
        )

    list_resp = await client.get("/api/v1/projects/var-values/variables")
    assert list_resp.status_code == 200
    variable = list_resp.json()["items"][0]
    assert variable["event_count"] == 1
    assert variable["context_count"] == 1
    assert variable["low_context_count"] == 1
    assert variable["high_context_count"] == 0
    assert variable["sample_values"] == ["u1", "u2"]
    # Event names ride along with the list so a client does not need one
    # /variables/{id}/values request per row to label the variable.
    assert variable["event_names"] == ["Profile View"]

    values_resp = await client.get(f"/api/v1/projects/var-values/variables/{variable_id}/values")
    assert values_resp.status_code == 200
    contexts = values_resp.json()
    assert contexts[0]["event_name"] == "Profile View"
    assert contexts[0]["field_name"] == "screen"
    assert contexts[0]["values"] == ["u1", "u2"]


@pytest.mark.asyncio
async def test_sample_values_stay_capped_however_many_contexts_feed_them(client: AsyncClient):
    """The cap belongs to the variable, not to one context row (tripl-x050).

    The accumulator is shared across a variable's contexts and was entered once
    per context, so every context past the first slipped one more novel value in
    before the length was tested: three full contexts here, and on production a
    variable with a hundred of them shipped 119 values under a schema that calls
    the cap hard. The row is a preview — ``/variables/{id}/values`` is where the
    full list lives — and this is the endpoint whose paging exists to keep
    clients off a multi-hundred-KB payload.
    """
    slug = "var-cap"
    await _setup_project(client, slug)
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et.json()['id']}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    created = await client.post(f"/api/v1/projects/{slug}/variables", json={"name": "variant"})
    variable_id = uuid.UUID(created.json()["id"])

    # Three contexts, each on its own event because a context is unique per
    # (variable, event, field), and each holding a full cap's worth of values
    # nothing else has seen.
    event_ids = []
    for index in range(3):
        event = await client.post(
            f"/api/v1/projects/{slug}/events",
            json={"event_type_id": et.json()["id"], "name": f"Event {index}"},
        )
        event_ids.append(uuid.UUID(event.json()["id"]))

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, variable_id)
        for index, event_id in enumerate(event_ids):
            session.add(
                VariableValue(
                    project_id=variable.project_id,
                    branch_id=variable.branch_id,
                    variable_id=variable_id,
                    event_id=event_id,
                    field_definition_id=uuid.UUID(field.json()["id"]),
                    source_column="screen",
                    value_kind="high",
                    observed_count=SUMMARY_VALUE_LIMIT,
                    values=[f"e{index}-v{n:02d}" for n in range(SUMMARY_VALUE_LIMIT)],
                )
            )

    async with TestSessionLocal() as session:
        variable = await session.get(Variable, variable_id)
        await attach_variable_summaries(session, [variable])
        # Before the fix this is SUMMARY_VALUE_LIMIT + 2 — one extra value for
        # each context that re-entered an already-full accumulator.
        assert len(variable.sample_values) == SUMMARY_VALUE_LIMIT

    listed = await client.get(f"/api/v1/projects/{slug}/variables")
    assert listed.status_code == 200
    assert len(listed.json()["items"][0]["sample_values"]) == SUMMARY_VALUE_LIMIT


@pytest.mark.asyncio
async def test_update_variable(client: AsyncClient):
    await _setup_project(client, "var-upd")
    create = await client.post(
        "/api/v1/projects/var-upd/variables",
        json={"name": "upd_var", "variable_type": "string"},
    )
    var_id = create.json()["id"]
    resp = await client.patch(
        f"/api/v1/projects/var-upd/variables/{var_id}",
        json={"variable_type": "boolean", "description": "Updated"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["variable_type"] == "boolean"
    assert data["description"] == "Updated"


@pytest.mark.asyncio
async def test_delete_variable(client: AsyncClient):
    await _setup_project(client, "var-del")
    create = await client.post(
        "/api/v1/projects/var-del/variables",
        json={"name": "del_var", "variable_type": "json"},
    )
    var_id = create.json()["id"]
    resp = await client.delete(f"/api/v1/projects/var-del/variables/{var_id}")
    assert resp.status_code == 204

    # verify it's gone
    list_resp = await client.get("/api/v1/projects/var-del/variables")
    assert list_resp.json() == {"items": [], "total": 0}


@pytest.mark.asyncio
async def test_delete_variable_does_not_scan_the_whole_variable_list(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    """A single delete must cost one indexed lookup, not a full list load.

    The audit record still needs the deleted name; the service now hands it
    back, so the handler no longer reaches for list_variables() — which made
    every delete pay for the whole project (tripl-jfm3.53).
    """
    await _setup_project(client, "var-del-cost")
    ids = []
    for name in ("del_a", "del_b", "del_c"):
        created = await client.post("/api/v1/projects/var-del-cost/variables", json={"name": name})
        ids.append(created.json()["id"])

    def _forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("delete must not load the whole variable list")

    monkeypatch.setattr(variable_service, "list_variables", _forbidden)

    resp = await client.delete(f"/api/v1/projects/var-del-cost/variables/{ids[1]}")
    assert resp.status_code == 204

    missing = await client.delete(f"/api/v1/projects/var-del-cost/variables/{uuid.uuid4()}")
    assert missing.status_code == 404

    audit = await client.get("/api/v1/audit?project_slug=var-del-cost")
    deletes = [e for e in audit.json()["items"] if e["action"] == "variable.delete"]
    assert [e["target_name"] for e in deletes] == ["del_b"]


@pytest.mark.asyncio
async def test_variable_types(client: AsyncClient):
    await _setup_project(client, "var-types")
    for vt in [
        "string",
        "number",
        "boolean",
        "date",
        "datetime",
        "json",
        "string_array",
        "number_array",
    ]:
        resp = await client.post(
            "/api/v1/projects/var-types/variables",
            json={"name": f"v_{vt}", "variable_type": vt},
        )
        assert resp.status_code == 201, f"Failed for type {vt}"
        assert resp.json()["variable_type"] == vt


@pytest.mark.asyncio
async def test_create_variable_with_values_and_bindings(client: AsyncClient):
    await _setup_project(client, "var-vals")
    resp = await client.post(
        "/api/v1/projects/var-vals/variables",
        json={
            "name": "variant",
            "variable_type": "string",
            "allowed_values": ["a", "b", "c"],
            "bindings": ["page_data.extra.variant"],
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["allowed_values"] == ["a", "b", "c"]
    assert data["bindings"] == ["page_data.extra.variant"]

    list_resp = await client.get("/api/v1/projects/var-vals/variables")
    assert list_resp.json()["items"][0]["allowed_values"] == ["a", "b", "c"]


@pytest.mark.asyncio
async def test_create_variable_invalid_binding_path(client: AsyncClient):
    await _setup_project(client, "var-badbind")
    resp = await client.post(
        "/api/v1/projects/var-badbind/variables",
        json={"name": "v_bad", "bindings": ["not a path!"]},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_binding_conflict_returns_409(client: AsyncClient):
    await _setup_project(client, "var-binddup")
    await client.post(
        "/api/v1/projects/var-binddup/variables",
        json={"name": "variant", "bindings": ["page_data.extra.variant"]},
    )
    resp = await client.post(
        "/api/v1/projects/var-binddup/variables",
        json={"name": "variant_two", "bindings": ["page_data.extra.variant"]},
    )
    assert resp.status_code == 409
    assert "already used" in resp.json()["detail"]

    # And via update on a third variable
    third = await client.post(
        "/api/v1/projects/var-binddup/variables", json={"name": "variant_three"}
    )
    upd = await client.patch(
        f"/api/v1/projects/var-binddup/variables/{third.json()['id']}",
        json={"bindings": ["page_data.extra.variant"]},
    )
    assert upd.status_code == 409


@pytest.mark.asyncio
async def test_binding_conflicts_with_other_variable_source_name(client: AsyncClient):
    await _setup_project(client, "var-bindsrc")
    created = await client.post("/api/v1/projects/var-bindsrc/variables", json={"name": "scanned"})
    async with TestSessionLocal() as session, session.begin():
        var = await session.get(Variable, uuid.UUID(created.json()["id"]))
        var.source_name = "raw.path.token"
    resp = await client.post(
        "/api/v1/projects/var-bindsrc/variables",
        json={"name": "manual", "bindings": ["raw.path.token"]},
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_rename_to_dotted_name_rejected_but_legacy_editable(client: AsyncClient):
    await _setup_project(client, "var-legacy")
    created = await client.post("/api/v1/projects/var-legacy/variables", json={"name": "plain_var"})
    var_id = created.json()["id"]
    # Renaming TO a dotted name is rejected by the service
    resp = await client.patch(
        f"/api/v1/projects/var-legacy/variables/{var_id}",
        json={"name": "page_data.extra.variant"},
    )
    assert resp.status_code == 422

    # A legacy dotted-named variable stays editable while the name is unchanged
    async with TestSessionLocal() as session, session.begin():
        var = await session.get(Variable, uuid.UUID(var_id))
        var.name = "page_data.extra.variant"
    resp = await client.patch(
        f"/api/v1/projects/var-legacy/variables/{var_id}",
        json={"name": "page_data.extra.variant", "description": "still editable"},
    )
    assert resp.status_code == 200
    assert resp.json()["description"] == "still editable"


@pytest.mark.asyncio
async def test_renaming_rewrites_the_token_in_meta_values_as_well_as_field_values(
    client: AsyncClient,
):
    """A rename carries through both surfaces that store a ``${token}``.

    An event's field values and its meta values are equally legal homes for a
    reference — the retirement predicate reads both for exactly that reason —
    and the rename rewrite only ever visited the first, so a ``${old_name}``
    parked in a meta value came out of the rename as a literal naming the old
    name (tripl-mpw3).
    """
    slug = "var-rename-meta"
    await _setup_project(client, slug)
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et.json()['id']}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    meta_field = await client.post(
        f"/api/v1/projects/{slug}/meta-fields",
        json={"name": "owner_note", "display_name": "Owner note", "field_type": "string"},
    )
    created = await client.post(f"/api/v1/projects/{slug}/variables", json={"name": "old_name"})
    var_id = created.json()["id"]

    event = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={
            "event_type_id": et.json()["id"],
            "name": "Profile View",
            "field_values": [
                {"field_definition_id": field.json()["id"], "value": "screen=${old_name}"}
            ],
            "meta_values": [
                {
                    "meta_field_definition_id": meta_field.json()["id"],
                    "value": "owned while ${old_name} is set",
                }
            ],
        },
    )
    assert event.status_code == 201
    event_id = event.json()["id"]

    renamed = await client.patch(
        f"/api/v1/projects/{slug}/variables/{var_id}",
        json={"name": "new_name"},
    )
    assert renamed.status_code == 200

    reloaded = await client.get(f"/api/v1/projects/{slug}/events/{event_id}")
    assert reloaded.status_code == 200
    # The field value was already rewritten; the meta value is the half that was
    # left holding "${old_name}".
    assert reloaded.json()["field_values"][0]["value"] == "screen=${new_name}"
    assert reloaded.json()["meta_values"][0]["value"] == "owned while ${new_name} is set"


async def _setup_event(client: AsyncClient, slug: str) -> tuple[str, str]:
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    et_id = et.json()["id"]
    event = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et_id, "name": "Onboarding Screen"},
    )
    return et_id, event.json()["id"]


@pytest.mark.asyncio
async def test_event_override_crud(client: AsyncClient):
    await _setup_project(client, "var-ovr")
    _, event_id = await _setup_event(client, "var-ovr")
    created = await client.post(
        "/api/v1/projects/var-ovr/variables",
        json={"name": "variant", "allowed_values": ["a", "b"]},
    )
    var_id = created.json()["id"]

    put = await client.put(
        f"/api/v1/projects/var-ovr/variables/{var_id}/event-overrides/{event_id}",
        json={"values": ["x", "y"]},
    )
    assert put.status_code == 200
    assert put.json()["values"] == ["x", "y"]
    assert put.json()["event_name"] == "Onboarding Screen"

    listed = await client.get(f"/api/v1/projects/var-ovr/variables/{var_id}/event-overrides")
    assert listed.status_code == 200
    assert len(listed.json()) == 1

    # PUT again replaces (upsert), no duplicate row
    put2 = await client.put(
        f"/api/v1/projects/var-ovr/variables/{var_id}/event-overrides/{event_id}",
        json={"values": ["z"]},
    )
    assert put2.status_code == 200
    assert put2.json()["values"] == ["z"]
    listed2 = await client.get(f"/api/v1/projects/var-ovr/variables/{var_id}/event-overrides")
    assert len(listed2.json()) == 1

    deleted = await client.delete(
        f"/api/v1/projects/var-ovr/variables/{var_id}/event-overrides/{event_id}"
    )
    assert deleted.status_code == 204
    listed3 = await client.get(f"/api/v1/projects/var-ovr/variables/{var_id}/event-overrides")
    assert listed3.json() == []


@pytest.mark.asyncio
async def test_event_override_404s(client: AsyncClient):
    await _setup_project(client, "var-ovr404")
    _, event_id = await _setup_event(client, "var-ovr404")
    created = await client.post("/api/v1/projects/var-ovr404/variables", json={"name": "variant"})
    var_id = created.json()["id"]
    missing = str(uuid.uuid4())

    resp = await client.put(
        f"/api/v1/projects/var-ovr404/variables/{missing}/event-overrides/{event_id}",
        json={"values": ["a"]},
    )
    assert resp.status_code == 404
    resp = await client.put(
        f"/api/v1/projects/var-ovr404/variables/{var_id}/event-overrides/{missing}",
        json={"values": ["a"]},
    )
    assert resp.status_code == 404
    resp = await client.delete(
        f"/api/v1/projects/var-ovr404/variables/{var_id}/event-overrides/{event_id}"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_bulk_update_variables(client: AsyncClient):
    await _setup_project(client, "var-bulk")
    ids = []
    for n in ["bulk_a", "bulk_b", "bulk_c"]:
        resp = await client.post(
            "/api/v1/projects/var-bulk/variables",
            json={"name": n, "allowed_values": ["keep", "drop"]},
        )
        ids.append(resp.json()["id"])

    resp = await client.post(
        "/api/v1/projects/var-bulk/variables/bulk-update",
        json={
            "variable_ids": ids[:2],
            "variable_type": "number",
            "allowed_values_add": ["new"],
            "allowed_values_remove": ["drop"],
        },
    )
    assert resp.status_code == 204

    listed = {
        v["name"]: v
        for v in (await client.get("/api/v1/projects/var-bulk/variables")).json()["items"]
    }
    for n in ["bulk_a", "bulk_b"]:
        assert listed[n]["variable_type"] == "number"
        assert listed[n]["allowed_values"] == ["keep", "new"]
    # Untouched variable keeps its type and values.
    assert listed["bulk_c"]["variable_type"] == "string"
    assert listed["bulk_c"]["allowed_values"] == ["keep", "drop"]


@pytest.mark.asyncio
async def test_bulk_update_requires_an_operation_and_known_ids(client: AsyncClient):
    await _setup_project(client, "var-bulk-val")
    created = await client.post(
        "/api/v1/projects/var-bulk-val/variables", json={"name": "only_var"}
    )
    var_id = created.json()["id"]

    no_op = await client.post(
        "/api/v1/projects/var-bulk-val/variables/bulk-update",
        json={"variable_ids": [var_id]},
    )
    assert no_op.status_code == 422

    unknown = await client.post(
        "/api/v1/projects/var-bulk-val/variables/bulk-update",
        json={"variable_ids": [var_id, str(uuid.uuid4())], "description": "x"},
    )
    assert unknown.status_code == 404


@pytest.mark.asyncio
async def test_bulk_delete_variables(client: AsyncClient):
    await _setup_project(client, "var-bulk-del")
    ids = []
    for n in ["del_a", "del_b", "del_keep"]:
        resp = await client.post("/api/v1/projects/var-bulk-del/variables", json={"name": n})
        ids.append(resp.json()["id"])

    resp = await client.post(
        "/api/v1/projects/var-bulk-del/variables/bulk-delete",
        json={"variable_ids": ids[:2]},
    )
    assert resp.status_code == 204
    remaining = (await client.get("/api/v1/projects/var-bulk-del/variables")).json()
    assert [v["name"] for v in remaining["items"]] == ["del_keep"]
    assert remaining["total"] == 1


@pytest.mark.asyncio
async def test_retirement_plan_asks_for_contexts_by_id_and_never_loads_them(client: AsyncClient):
    """The plan answers "has contexts?" with an anti-join, so it must not hydrate
    them (tripl-xkbb).

    ``Variable.value_contexts`` is ``lazy="selectin"`` and every context then
    selectin-loads its FieldDefinition, so a bare whole-project
    ``select(Variable)`` pulled the project's entire context table and every
    field definition it references into memory — to answer a question the
    indexed ``with_contexts`` id set below already answers. This runs on every
    ``GET /variables?usage=used|unused``, not only in the danger zone.
    """
    slug = "var-plan-reads"
    await _setup_project(client, slug)
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et.json()['id']}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    created_event = await client.post(
        f"/api/v1/projects/{slug}/events",
        json={"event_type_id": et.json()["id"], "name": "Profile View"},
    )
    created = await client.post(f"/api/v1/projects/{slug}/variables", json={"name": "variant"})
    variable_id = uuid.UUID(created.json()["id"])
    # The project_id comes off the response rather than a session load: loading
    # the Variable here would fire the very selectin this test counts.
    project_id = uuid.UUID(created.json()["project_id"])

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, variable_id)
        session.add(
            VariableValue(
                project_id=variable.project_id,
                branch_id=variable.branch_id,
                variable_id=variable_id,
                event_id=uuid.UUID(created_event.json()["id"]),
                field_definition_id=uuid.UUID(field.json()["id"]),
                source_column="screen",
                value_kind="low",
                observed_count=1,
                values=["a"],
            )
        )

    statements: list[str] = []

    def _record(conn, cursor, statement, parameters, context, executemany) -> None:
        statements.append(" ".join(statement.split()))

    # A fresh session, so nothing the fixture loaded is already in the identity
    # map and able to satisfy a loader without a query.
    async with TestSessionLocal() as session:
        sa_event.listen(engine.sync_engine, "before_cursor_execute", _record)
        try:
            await variable_retirement_service.plan_project_retirement(
                session, project_id=project_id, branch_id=None
            )
        finally:
            sa_event.remove(engine.sync_engine, "before_cursor_execute", _record)

    context_reads = [s for s in statements if "FROM variable_values" in s]
    assert len(context_reads) == 1, statements
    assert context_reads[0].startswith("SELECT DISTINCT")
    # The FieldDefinition hop belongs to a loaded context and to nothing else the
    # plan does, so its absence is the second half of the same claim.
    assert [s for s in statements if "FROM field_definitions" in s] == []


class _VariableHistory(NamedTuple):
    """Handles for the variable the exclusion tests act on."""

    slug: str
    variable_id: uuid.UUID


@pytest.fixture
async def variable_history(client: AsyncClient) -> _VariableHistory:
    """A variable carrying everything an exclude must now leave alone.

    Two observed contexts over two events, and one drift per verdict — the
    resolved verdicts included, because an accepted or dismissed drift records a
    decision somebody made and is worth more than an open one, not less. Drift
    rows are unique per (variable, event), so each verdict needs its own event.
    """
    slug = "var-excl"
    await _setup_project(client, slug)
    et = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    field = await client.post(
        f"/api/v1/projects/{slug}/event-types/{et.json()['id']}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    event_ids: dict[str, uuid.UUID] = {}
    for event_name in ("Onboarding", "Checkout", "Signup", "Settings"):
        created_event = await client.post(
            f"/api/v1/projects/{slug}/events",
            json={"event_type_id": et.json()["id"], "name": event_name},
        )
        event_ids[event_name] = uuid.UUID(created_event.json()["id"])
    created = await client.post(
        f"/api/v1/projects/{slug}/variables",
        json={"name": "variant", "allowed_values": ["a"], "bindings": ["screen"]},
    )
    variable_id = uuid.UUID(created.json()["id"])

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, variable_id)
        for event_name, kind, observed_count, values in (
            ("Onboarding", "low", 2, ["a", "b"]),
            ("Checkout", "high", 9, ["c"]),
        ):
            session.add(
                VariableValue(
                    project_id=variable.project_id,
                    branch_id=variable.branch_id,
                    variable_id=variable_id,
                    event_id=event_ids[event_name],
                    field_definition_id=uuid.UUID(field.json()["id"]),
                    source_column="screen",
                    value_kind=kind,
                    observed_count=observed_count,
                    values=values,
                )
            )
        for event_name, status in (
            ("Onboarding", "open"),
            ("Checkout", "accepted"),
            ("Signup", "false_positive"),
            ("Settings", "snoozed"),
        ):
            session.add(
                VariableValueDrift(
                    project_id=variable.project_id,
                    variable_id=variable_id,
                    event_id=event_ids[event_name],
                    observed_values=["b"],
                    status=status,
                    # Snoozed past the horizon so the open row is the only active
                    # one, which gives the badge test a count of exactly 1 to
                    # watch fall to 0.
                    snoozed_until=(
                        datetime.now(UTC) + timedelta(days=30) if status == "snoozed" else None
                    ),
                )
            )

    return _VariableHistory(slug=slug, variable_id=variable_id)


async def _variable_row(client: AsyncClient, slug: str) -> dict[str, Any]:
    listed = await client.get(f"/api/v1/projects/{slug}/variables")
    assert listed.status_code == 200
    return listed.json()["items"][0]


@pytest.mark.asyncio
async def test_excluding_a_variable_keeps_its_values_and_every_drift_verdict(
    client: AsyncClient, variable_history: _VariableHistory
):
    """Excluding sets a flag and deletes nothing (tripl-95pu).

    It used to purge every VariableValue and VariableValueDrift for the
    variable, behind a control the UI offers as reversible: Restore handed back
    an emptied variable, and the resolved drifts — the record of what somebody
    already decided — were gone with nothing that could rebuild them.
    """
    slug, variable_id = variable_history

    resp = await client.patch(
        f"/api/v1/projects/{slug}/variables/{variable_id}",
        json={"excluded_from_scans": True},
    )
    assert resp.status_code == 200
    assert resp.json()["excluded_from_scans"] is True
    assert resp.json()["allowed_values"] == ["a"]

    values = await client.get(f"/api/v1/projects/{slug}/variables/{variable_id}/values")
    assert values.status_code == 200
    assert [(c["event_name"], c["values"]) for c in values.json()] == [
        ("Checkout", ["c"]),
        ("Onboarding", ["a", "b"]),
    ]

    drifts = await client.get(f"/api/v1/projects/{slug}/variables/drifts?variable_id={variable_id}")
    assert drifts.status_code == 200
    assert {(d["event_name"], d["status"]) for d in drifts.json()["items"]} == {
        ("Onboarding", "open"),
        ("Checkout", "accepted"),
        ("Signup", "false_positive"),
        ("Settings", "snoozed"),
    }


@pytest.mark.asyncio
async def test_excluding_zeroes_the_drift_badge_and_no_other_count(
    client: AsyncClient, variable_history: _VariableHistory
):
    """The badge counts work; the rest count facts (tripl-95pu).

    Nothing refreshes or reopens an excluded variable's drifts and the worker
    raises no alerts for them, so a badge would send the operator to a queue
    with nothing actionable in it. The counts beside it describe rows that are
    still there, and zeroing those would print absence as zero — the reading
    this branch removed everywhere else.
    """
    slug, variable_id = variable_history

    before = await _variable_row(client, slug)
    assert before["open_drift_count"] == 1

    resp = await client.patch(
        f"/api/v1/projects/{slug}/variables/{variable_id}",
        json={"excluded_from_scans": True},
    )
    assert resp.status_code == 200

    after = await _variable_row(client, slug)
    assert after["excluded_from_scans"] is True
    assert after["open_drift_count"] == 0
    for counted in ("event_count", "context_count", "low_context_count", "high_context_count"):
        assert after[counted] == before[counted] > 0
    assert sorted(after["sample_values"]) == ["a", "b", "c"]
    assert after["event_names"] == ["Checkout", "Onboarding"]


@pytest.mark.asyncio
async def test_un_excluding_restores_the_variable_without_a_rescan(
    client: AsyncClient, variable_history: _VariableHistory
):
    """Restore is immediate because nothing was ever taken away (tripl-95pu).

    No scan runs here, and that is the assertion. When excluding purged the
    rows, Restore returned a variable with no observed values and no history,
    and only the next scheduled scan could refill the part of it that a scan can
    see at all.
    """
    slug, variable_id = variable_history

    excluded = await client.patch(
        f"/api/v1/projects/{slug}/variables/{variable_id}",
        json={"excluded_from_scans": True},
    )
    assert excluded.status_code == 200
    restored = await client.patch(
        f"/api/v1/projects/{slug}/variables/{variable_id}",
        json={"excluded_from_scans": False},
    )
    assert restored.status_code == 200
    assert restored.json()["excluded_from_scans"] is False

    row = await _variable_row(client, slug)
    assert row["context_count"] == 2
    assert sorted(row["sample_values"]) == ["a", "b", "c"]
    # The badge comes back with it, because the drift it counts never left.
    assert row["open_drift_count"] == 1

    values = await client.get(f"/api/v1/projects/{slug}/variables/{variable_id}/values")
    assert [c["values"] for c in values.json()] == [["c"], ["a", "b"]]


@pytest.fixture
def sync_session() -> Iterator[Session]:
    """The worker-side harness, as ``test_variable_value_drift_alerts`` builds it.

    ``_get_active_variable_value_drift_candidates`` runs in the Celery worker
    against a sync Session, so the AsyncClient tests above cannot reach it.
    """
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_excluded_variable_raises_no_drift_alert_candidate(sync_session: Session):
    """The guard that replaced the purge, and reaches where it never did.

    Deleting the drift rows on exclude silenced alerts for the one variable the
    endpoint touched. Retirement, branch merge and branch revert all carry
    ``excluded_from_scans`` across without deleting anything, so a variable
    excluded through any of those doors kept paging an operator who had taken it
    out of scanning. Asking the flag here covers all of them (tripl-95pu).
    """
    project = Project(id=uuid.uuid4(), name="P", slug="vvd-excluded", description="")
    sync_session.add(project)
    sync_session.flush()
    data_source = DataSource(
        id=uuid.uuid4(),
        name="wh",
        db_type="clickhouse",
        host="localhost",
        port=9000,
        database_name="db",
        username="u",
        password_encrypted="x",
    )
    sync_session.add(data_source)
    sync_session.flush()
    config = ScanConfig(
        id=uuid.uuid4(),
        project_id=project.id,
        data_source_id=data_source.id,
        name="scan",
        base_query="SELECT * FROM events",
    )
    event_type = EventType(
        id=uuid.uuid4(), project_id=project.id, name="pv", display_name="PV", description=""
    )
    sync_session.add_all([config, event_type])
    sync_session.flush()
    event = Event(
        id=uuid.uuid4(),
        project_id=project.id,
        event_type_id=event_type.id,
        name="Onboarding",
        description="",
        order=0,
    )
    variable = Variable(
        id=uuid.uuid4(),
        project_id=project.id,
        name="variant",
        variable_type="string",
        description="",
        excluded_from_scans=True,
    )
    sync_session.add_all([event, variable])
    sync_session.flush()
    sync_session.add(
        VariableValueDrift(
            project_id=project.id,
            variable_id=variable.id,
            event_id=event.id,
            scan_config_id=config.id,
            observed_values=["x"],
            detected_at=datetime.now(UTC),
        )
    )
    sync_session.commit()

    assert _get_active_variable_value_drift_candidates(sync_session, config) == {}

    # The row was alertable the whole time; only the flag stood in front of it.
    variable.excluded_from_scans = False
    sync_session.commit()
    candidates = _get_active_variable_value_drift_candidates(sync_session, config)
    assert [candidate.drift_field for candidate in candidates.values()] == ["variant"]
