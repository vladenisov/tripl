import uuid

import pytest
from httpx import AsyncClient

from tripl.models.event import Event
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue
from tripl.services import variable_service
from tripl.tests.conftest import TestSessionLocal


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
async def test_exclude_from_scans_purges_observed_data_keeps_documentation(
    client: AsyncClient,
):
    from tripl.models.variable_value_drift import VariableValueDrift

    await _setup_project(client, "var-excl")
    et = await client.post(
        "/api/v1/projects/var-excl/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    field = await client.post(
        f"/api/v1/projects/var-excl/event-types/{et.json()['id']}/fields",
        json={"name": "screen", "display_name": "Screen", "field_type": "string"},
    )
    event = await client.post(
        "/api/v1/projects/var-excl/events",
        json={"event_type_id": et.json()["id"], "name": "Onboarding"},
    )
    created = await client.post(
        "/api/v1/projects/var-excl/variables",
        json={"name": "variant", "allowed_values": ["a"], "bindings": ["screen"]},
    )
    var_id = uuid.UUID(created.json()["id"])
    event_id = uuid.UUID(event.json()["id"])

    async with TestSessionLocal() as session, session.begin():
        variable = await session.get(Variable, var_id)
        session.add(
            VariableValue(
                project_id=variable.project_id,
                branch_id=variable.branch_id,
                variable_id=var_id,
                event_id=event_id,
                field_definition_id=uuid.UUID(field.json()["id"]),
                source_column="screen",
                value_kind="low",
                observed_count=2,
                values=["x"],
            )
        )
        session.add(
            VariableValueDrift(
                project_id=variable.project_id,
                variable_id=var_id,
                event_id=event_id,
                observed_values=["x"],
            )
        )

    resp = await client.patch(
        f"/api/v1/projects/var-excl/variables/{var_id}",
        json={"excluded_from_scans": True},
    )
    assert resp.status_code == 200
    assert resp.json()["excluded_from_scans"] is True
    # Documentation survives; observed contexts and drift are purged.
    assert resp.json()["allowed_values"] == ["a"]

    listed = await client.get("/api/v1/projects/var-excl/variables")
    row = listed.json()["items"][0]
    assert row["excluded_from_scans"] is True
    assert row["context_count"] == 0
    assert row["sample_values"] == []
    assert row["event_names"] == []
    assert row["open_drift_count"] == 0

    # Restore clears the tombstone.
    restored = await client.patch(
        f"/api/v1/projects/var-excl/variables/{var_id}",
        json={"excluded_from_scans": False},
    )
    assert restored.json()["excluded_from_scans"] is False
