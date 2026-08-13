"""Per-chunk processing for metrics collection.

Extracted verbatim from the chunk loop of ``collect_metrics`` in ``tasks.py``.
Each call runs one bounded warehouse query, the matching delete pass, row
aggregation, and the UPSERTs, then commits.  ``upsert_event_metrics_rows_fn``
is injected so tests monkey-patching ``tasks._upsert_event_metrics_rows``
keep taking effect.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Protocol, cast

from sqlalchemy.orm import Session

from tripl.core.adapters.base import BaseAdapter
from tripl.core.analyzers.event_generator import GenerationResult
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.scan_config import ScanConfig
from tripl.models.shadow_event_candidate import SHADOW_STATUS_NEW
from tripl.models.variable import Variable
from tripl.worker.tasks._errors import ScanError
from tripl.worker.tasks.metrics.collect import _bump_event_last_seen
from tripl.worker.tasks.metrics.generation import (
    _accumulate_replay_variable_samples,
)
from tripl.worker.tasks.metrics.metric_rows import (
    _build_event_name_from_row,
    _collect_app_version_breakdown_rows,
    _collect_distribution_drift_rows,
    _collect_metric_breakdown_rows,
    _delete_coverage_metrics_window,
    _delete_distribution_drifts_rows,
    _delete_distribution_drifts_window,
    _delete_event_metric_breakdown_rows,
    _delete_event_metric_breakdowns_column_window,
    _delete_event_metric_breakdowns_window,
    _delete_event_metrics_rows,
    _delete_event_metrics_window,
    _delete_event_type_metrics_rows,
    _upsert_coverage_rows,
    _upsert_event_metric_breakdown_rows,
    _upsert_shadow_event_candidates,
)

logger = logging.getLogger(__name__)


class _UpsertMetricsFn(Protocol):
    def __call__(
        self, session: Session, *, rows: list[dict[str, object]], constraint: str
    ) -> None: ...


@dataclass
class ChunkStats:
    rows_scanned: int = 0
    metrics_deleted: int = 0
    breakdown_metrics_deleted: int = 0
    distribution_drifts_deleted: int = 0
    n_ev: int = 0
    n_tp: int = 0
    n_breakdown_ev: int = 0
    n_breakdown_tp: int = 0
    n_distribution_drifts: int = 0
    significant_distribution_drifts: int = 0
    # Warehouse volume that resolved to an ARCHIVED plan identity. Held out of
    # coverage entirely (see ``process_chunk``), so this is the only place the
    # run still reports "you put this away and it is still arriving".
    archived_volume: int = 0
    archived_identities_seen: set[str] = field(default_factory=set)


def _delete_chunk_window(
    session: Session,
    *,
    config: ScanConfig,
    chunk_from: datetime,
    chunk_to: datetime,
    stats: ChunkStats,
) -> None:
    stats.metrics_deleted += _delete_event_metrics_window(
        session,
        scan_config_id=config.id,
        time_from=chunk_from,
        time_to=chunk_to,
    )
    stats.breakdown_metrics_deleted += _delete_event_metric_breakdowns_window(
        session,
        scan_config_id=config.id,
        time_from=chunk_from,
        time_to=chunk_to,
    )
    stats.distribution_drifts_deleted += _delete_distribution_drifts_window(
        session,
        scan_config_id=config.id,
        time_from=chunk_from,
        time_to=chunk_to,
    )
    _delete_coverage_metrics_window(
        session,
        scan_config_id=config.id,
        time_from=chunk_from,
        time_to=chunk_to,
    )


def process_chunk(
    session: Session,
    *,
    adapter: BaseAdapter,
    config: ScanConfig,
    interval_code: str,
    interval_delta: timedelta,
    regular_cols: list[str],
    json_cols: list[str],
    json_value_path_map: dict[str, list[str]],
    metrics_row_limit: int,
    is_replay: bool,
    gen_results: dict[str, GenerationResult],
    single_result: GenerationResult | None,
    et_by_name: dict[str, EventType],
    et_col_idx: int | None,
    reg_index: dict[str, int],
    json_index: dict[str, int],
    n_reg: int,
    replay_variables_by_token: dict[str, Variable],
    replay_variable_samples: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, object]],
    chunk_from: datetime,
    chunk_to: datetime,
    upsert_event_metrics_rows_fn: _UpsertMetricsFn,
) -> ChunkStats:
    stats = ChunkStats()
    if config.time_column is None:
        msg = "ScanConfig time_column is required for metrics collection"
        raise ValueError(msg)

    _col_names, json_value_names, rows = adapter.get_time_bucketed_counts(
        config.base_query,
        config.time_column,
        interval_code,
        regular_cols,
        json_cols,
        json_value_path_map,
        chunk_from,
        chunk_to,
        limit=metrics_row_limit + 1,
    )
    query_truncated = len(rows) > metrics_row_limit
    rows = rows[:metrics_row_limit]
    stats.rows_scanned = len(rows)
    if query_truncated:
        # ScanError, not ValueError: this message already names the setting to
        # change, and only a ScanError survives ``user_facing_error`` verbatim.
        # As a ValueError it was replaced on ScanJob.error_message by the generic
        # "Scan failed due to an internal error.", so the one thing that would
        # have told the user what to do only ever reached the worker log
        # (tripl-embs).
        msg = (
            "Metrics query reached configured row limit "
            f"({metrics_row_limit}) for chunk "
            f"{chunk_from.isoformat()}..{chunk_to.isoformat()}; "
            "increase metrics_row_limit to avoid partial metrics"
        )
        raise ScanError(msg)
    logger.info(
        "Got %s bucketed rows from warehouse for %s..%s",
        len(rows),
        chunk_from.isoformat(),
        chunk_to.isoformat(),
    )

    if not is_replay:
        _delete_chunk_window(
            session,
            config=config,
            chunk_from=chunk_from,
            chunk_to=chunk_to,
            stats=stats,
        )

    if is_replay and not rows:
        _delete_chunk_window(
            session,
            config=config,
            chunk_from=chunk_from,
            chunk_to=chunk_to,
            stats=stats,
        )
        session.commit()
        return stats

    # Aggregate metrics: (scan_config_id, event_id, bucket) -> count
    event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}
    # (scan_config_id, event_type_id, bucket) -> count
    type_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}
    # Reconciliation: bucket -> [total_count, matched_count]
    coverage_agg: dict[datetime, list[int]] = {}
    # (event_type_id | None, event_name) -> [count, first_bucket, last_bucket]
    shadow_agg: dict[tuple[uuid.UUID | None, str], list[object]] = {}

    for row in rows:
        bucket = cast(datetime, row[0])
        data_row = row[1:]  # strip _bucket; _cnt is last but not indexed by col_meta
        cnt = int(cast(int | str | float, row[-1]))
        col_meta: dict[str, dict[str, object]]
        events_by_name: dict[str, Event]
        archived_identities: set[str]
        event_type_id: uuid.UUID | None

        # Coverage denominator counts every returned row — including
        # rows dropped below for an unknown event type, which are by
        # definition unmatched plan volume.
        coverage_entry = coverage_agg.setdefault(bucket, [0, 0])
        coverage_entry[0] += cnt

        # Determine event type and get the matching gen result
        if config.event_type_column and et_col_idx is not None:
            et_name = str(data_row[et_col_idx])
            event_type = et_by_name.get(et_name)
            if event_type is None:
                continue
            event_type_id = event_type.id
            gen_result: GenerationResult | None = gen_results.get(et_name)
            if gen_result is None:
                continue
            col_meta = gen_result.col_meta
            events_by_name = gen_result.events_by_name
            archived_identities = gen_result.archived_identities
        else:
            event_type_id = config.event_type_id
            if single_result is None:
                continue
            col_meta = single_result.col_meta
            events_by_name = single_result.events_by_name
            archived_identities = single_result.archived_identities

        # Build event name from row (same logic as generate_events)
        event_name = _build_event_name_from_row(
            data_row,
            col_meta,
            reg_index,
            json_index,
            n_reg,
            json_value_names,
            config.event_name_format,
            config.event_group_rules,
        )

        if event_name:
            ev = events_by_name.get(event_name)
            if isinstance(ev, Event):
                coverage_entry[1] += cnt
                key = (config.id, ev.id, bucket)
                event_agg[key] = event_agg.get(key, 0) + cnt
                if is_replay and replay_variables_by_token:
                    _accumulate_replay_variable_samples(
                        replay_variable_samples,
                        event=ev,
                        data_row=data_row,
                        reg_index=reg_index,
                        n_reg=n_reg,
                        n_json=len(json_cols),
                        json_value_names=json_value_names,
                        variable_by_token=replay_variables_by_token,
                    )
            elif event_name in archived_identities:
                # Archived, not unplanned. The identity IS in the plan — the user
                # put it away — so filing it as a shadow candidate resurrects the
                # very row they retired. Take its volume back OUT of the
                # denominator too: coverage asks "of the traffic the plan is meant
                # to describe, how much does it describe", and archiving withdraws
                # the event from that question on both sides. Leaving it in the
                # denominator alone made archiving a busy event silently tank the
                # project's coverage percentage (tripl-w3ms). The volume is not
                # lost — it still lands in the event-type series below, and the
                # run reports it via ``ChunkStats.archived_volume``.
                coverage_entry[0] -= cnt
                stats.archived_volume += cnt
                stats.archived_identities_seen.add(event_name)
            else:
                # Shadow candidate: warehouse identity with no plan
                # event. Tracked per (event_type, identity).
                shadow_key = (event_type_id, event_name)
                shadow_entry = shadow_agg.get(shadow_key)
                if shadow_entry is None:
                    shadow_agg[shadow_key] = [cnt, bucket, bucket]
                else:
                    shadow_entry[0] = cast(int, shadow_entry[0]) + cnt
                    shadow_entry[1] = min(cast(datetime, shadow_entry[1]), bucket)
                    shadow_entry[2] = max(cast(datetime, shadow_entry[2]), bucket)

        if event_type_id:
            key = (config.id, event_type_id, bucket)
            type_agg[key] = type_agg.get(key, 0) + cnt

    # Build metrics rows for UPSERT
    event_rows: list[dict[str, object]] = [
        {
            "id": uuid.uuid4(),
            "scan_config_id": sc_id,
            "event_id": ev_id,
            "event_type_id": None,
            "bucket": bucket,
            "count": total,
        }
        for (sc_id, ev_id, bucket), total in event_agg.items()
    ]
    type_rows: list[dict[str, object]] = [
        {
            "id": uuid.uuid4(),
            "scan_config_id": sc_id,
            "event_id": None,
            "event_type_id": et_id,
            "bucket": bucket,
            "count": total,
        }
        for (sc_id, et_id, bucket), total in type_agg.items()
    ]
    (
        breakdown_event_rows,
        breakdown_type_rows,
        breakdown_truncated,
    ) = _collect_metric_breakdown_rows(
        adapter=adapter,
        config=config,
        interval_code=interval_code,
        regular_cols=regular_cols,
        json_cols=json_cols,
        json_value_path_map=json_value_path_map,
        time_from=chunk_from,
        time_to=chunk_to,
        query_row_limit=metrics_row_limit,
        reg_index=reg_index,
        json_index=json_index,
        n_reg=n_reg,
        gen_results=gen_results,
        single_result=single_result,
        et_by_name=et_by_name,
    )
    if breakdown_truncated:
        # ScanError so the "increase metrics_row_limit" instruction survives
        # user_facing_error and lands on ScanJob.error_message (tripl-embs).
        msg = (
            "Metrics breakdown query reached configured row limit "
            f"({metrics_row_limit}) for chunk "
            f"{chunk_from.isoformat()}..{chunk_to.isoformat()}; "
            "increase metrics_row_limit to avoid partial breakdown metrics"
        )
        raise ScanError(msg)

    # App-version series are stored on the same breakdown path (same table and
    # row shape) but use SemVer-aware latest-N retention instead of top-N by
    # volume. Merging here lets the delete/upsert/stats logic below treat them
    # uniformly. Inert (empty) when the scan has no app_version_column.
    (
        version_event_rows,
        version_type_rows,
    ) = _collect_app_version_breakdown_rows(
        config=config,
        regular_cols=regular_cols,
        rows=rows,
        json_value_names=json_value_names,
        reg_index=reg_index,
        json_index=json_index,
        n_reg=n_reg,
        gen_results=gen_results,
        single_result=single_result,
        et_by_name=et_by_name,
    )
    breakdown_event_rows.extend(version_event_rows)
    breakdown_type_rows.extend(version_type_rows)

    (
        chunk_drift_rows,
        chunk_significant_drifts,
        drifts_truncated,
    ) = _collect_distribution_drift_rows(
        adapter=adapter,
        config=config,
        interval_code=interval_code,
        interval_delta=interval_delta,
        regular_cols=regular_cols,
        json_cols=json_cols,
        json_value_path_map=json_value_path_map,
        time_from=chunk_from,
        time_to=chunk_to,
        query_row_limit=metrics_row_limit,
        reg_index=reg_index,
        et_by_name=et_by_name,
    )
    if drifts_truncated:
        # ScanError so the "increase metrics_row_limit" instruction survives
        # user_facing_error and lands on ScanJob.error_message (tripl-embs).
        msg = (
            "Distribution drift query reached configured row limit "
            f"({metrics_row_limit}) for chunk "
            f"{chunk_from.isoformat()}..{chunk_to.isoformat()}; "
            "increase metrics_row_limit to avoid partial drift detection"
        )
        raise ScanError(msg)

    if is_replay:
        event_delete_keys: list[tuple[uuid.UUID, datetime]] = [
            (ev_id, bucket) for (_, ev_id, bucket) in event_agg
        ]
        type_delete_keys: list[tuple[uuid.UUID, datetime]] = [
            (et_id, bucket) for (_, et_id, bucket) in type_agg
        ]
        breakdown_event_delete_keys: list[tuple[uuid.UUID, datetime, str, str, bool]] = [
            (
                cast(uuid.UUID, row["event_id"]),
                cast(datetime, row["bucket"]),
                cast(str, row["breakdown_column"]),
                cast(str, row["breakdown_value"]),
                cast(bool, row["is_other"]),
            )
            for row in breakdown_event_rows
        ]
        breakdown_type_delete_keys: list[tuple[uuid.UUID, datetime, str, str, bool]] = [
            (
                cast(uuid.UUID, row["event_type_id"]),
                cast(datetime, row["bucket"]),
                cast(str, row["breakdown_column"]),
                cast(str, row["breakdown_value"]),
                cast(bool, row["is_other"]),
            )
            for row in breakdown_type_rows
        ]
        drift_delete_keys: list[tuple[uuid.UUID | None, datetime, str]] = [
            (
                cast(uuid.UUID | None, row["event_type_id"]),
                cast(datetime, row["bucket"]),
                cast(str, row["field_name"]),
            )
            for row in chunk_drift_rows
        ]

        stats.metrics_deleted += _delete_event_metrics_rows(
            session,
            scan_config_id=config.id,
            keys=event_delete_keys,
        )
        stats.metrics_deleted += _delete_event_type_metrics_rows(
            session,
            scan_config_id=config.id,
            keys=type_delete_keys,
        )
        stats.breakdown_metrics_deleted += _delete_event_metric_breakdown_rows(
            session,
            scan_config_id=config.id,
            keys=breakdown_event_delete_keys,
            constraint="event",
        )
        stats.breakdown_metrics_deleted += _delete_event_metric_breakdown_rows(
            session,
            scan_config_id=config.id,
            keys=breakdown_type_delete_keys,
            constraint="type",
        )
        # App-version breakdowns now store every version verbatim (retention is a
        # read-time concern). Clear the whole version column for this window so a
        # re-collection drops obsolete versions and legacy is_other="Other" rows
        # instead of leaving them to double-count at read time.
        if config.app_version_column:
            stats.breakdown_metrics_deleted += _delete_event_metric_breakdowns_column_window(
                session,
                scan_config_id=config.id,
                breakdown_column=config.app_version_column,
                time_from=chunk_from,
                time_to=chunk_to,
            )
        stats.distribution_drifts_deleted += _delete_distribution_drifts_rows(
            session,
            scan_config_id=config.id,
            keys=drift_delete_keys,
        )

    upsert_event_metrics_rows_fn(
        session,
        rows=event_rows,
        constraint="uq_event_metric_config_event_bucket",
    )
    upsert_event_metrics_rows_fn(
        session,
        rows=type_rows,
        constraint="uq_event_metric_config_type_bucket",
    )
    _bump_event_last_seen(session, event_agg=event_agg)
    _upsert_coverage_rows(
        session,
        rows=[
            {
                "id": uuid.uuid4(),
                "scan_config_id": config.id,
                "bucket": bucket,
                "total_count": totals[0],
                "matched_count": totals[1],
            }
            for bucket, totals in coverage_agg.items()
        ],
    )
    _upsert_shadow_event_candidates(
        session,
        rows=[
            {
                "id": uuid.uuid4(),
                "project_id": config.project_id,
                "scan_config_id": config.id,
                "event_type_id": event_type_id_key,
                "event_name": event_name_key,
                "observed_count": cast(int, entry[0]),
                "first_seen_at": cast(datetime, entry[1]),
                "last_seen_at": cast(datetime, entry[2]),
                "status": SHADOW_STATUS_NEW,
            }
            for (event_type_id_key, event_name_key), entry in shadow_agg.items()
        ],
    )
    _upsert_event_metric_breakdown_rows(
        session,
        rows=breakdown_event_rows,
        constraint="event",
    )
    _upsert_event_metric_breakdown_rows(
        session,
        rows=breakdown_type_rows,
        constraint="type",
    )
    if chunk_drift_rows:
        session.add_all(DistributionDrift(**row) for row in chunk_drift_rows)

    session.commit()

    stats.n_ev = len(event_rows)
    stats.n_tp = len(type_rows)
    stats.n_breakdown_ev = len(breakdown_event_rows)
    stats.n_breakdown_tp = len(breakdown_type_rows)
    stats.n_distribution_drifts = len(chunk_drift_rows)
    stats.significant_distribution_drifts = chunk_significant_drifts
    return stats
