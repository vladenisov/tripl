import uuid
from datetime import datetime
from math import inf

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.crypto import decrypt_value
from tripl.json_paths import (
    decode_json_path_value,
    flatten_json_paths,
    format_json_path_value,
)
from tripl.models.data_source import DataSource
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.schemas.scan_config import (
    ScanConfigCreate,
    ScanConfigPreviewRequest,
    ScanConfigPreviewResponse,
    ScanConfigUpdate,
    ScanMetricsReplayRequest,
    ScanPreviewColumnResponse,
    ScanPreviewJsonColumnResponse,
    ScanPreviewJsonPathResponse,
)
from tripl.worker.adapters.base import BaseAdapter, ColumnInfo
from tripl.worker.adapters.clickhouse import ClickHouseAdapter
from tripl.worker.analyzers.cardinality import _is_json_type


async def _get_project_id(session: AsyncSession, slug: str) -> uuid.UUID:
    result = await session.execute(select(Project.id).where(Project.slug == slug))
    project_id = result.scalar_one_or_none()
    if project_id is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project_id


async def _verify_data_source(session: AsyncSession, ds_id: uuid.UUID) -> DataSource:
    result = await session.execute(select(DataSource).where(DataSource.id == ds_id))
    ds = result.scalar_one_or_none()
    if ds is None:
        raise HTTPException(status_code=404, detail="Data source not found")
    return ds


def _build_adapter(ds: DataSource) -> BaseAdapter:
    password = decrypt_value(ds.password_encrypted)
    if ds.db_type != "clickhouse":
        raise HTTPException(status_code=400, detail=f"Unsupported data source type: {ds.db_type}")
    return ClickHouseAdapter(
        host=ds.host,
        port=ds.port,
        database=ds.database_name,
        username=ds.username,
        password=password,
    )


def _validate_metric_breakdown_selection(
    *,
    metric_breakdown_columns: list[str],
    event_type_column: str | None,
    time_column: str | None,
) -> None:
    reserved = {column for column in (event_type_column, time_column) if column}
    invalid = sorted(set(metric_breakdown_columns) & reserved)
    if invalid:
        raise HTTPException(
            status_code=422,
            detail="metric_breakdown_columns cannot include event_type_column or time_column",
        )


def _serialize_preview_value(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool, list, dict)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _is_feature_worth_sampling(unique_count: int, total_rows: int) -> bool:
    if unique_count <= 1:
        return False
    if unique_count >= total_rows:
        return False
    return unique_count <= max(10, total_rows // 2)


def _select_diverse_preview_rows(
    columns: list[ColumnInfo],
    raw_rows: list[dict[str, object]],
    *,
    limit: int,
) -> list[dict[str, object]]:
    if len(raw_rows) <= limit:
        return raw_rows

    column_map = {column.name: column for column in columns}
    feature_values_by_name: dict[str, set[str]] = {}
    row_features: list[list[tuple[str, str]]] = []

    for row in raw_rows:
        features: list[tuple[str, str]] = []
        for column_name, raw_value in row.items():
            column = column_map[column_name]
            if _is_json_type(column.type_name):
                parsed_value = decode_json_path_value(raw_value)
                for path, nested_value in flatten_json_paths(parsed_value):
                    feature_name = f"{column_name}.{path}"
                    feature_value = format_json_path_value(nested_value)
                    features.append((feature_name, feature_value))
                    feature_values_by_name.setdefault(feature_name, set()).add(feature_value)
                continue

            feature_value = format_json_path_value(raw_value)
            features.append((column_name, feature_value))
            feature_values_by_name.setdefault(column_name, set()).add(feature_value)
        row_features.append(features)

    eligible_feature_names = {
        feature_name
        for feature_name, values in feature_values_by_name.items()
        if _is_feature_worth_sampling(len(values), len(raw_rows))
    }
    if not eligible_feature_names:
        return raw_rows[:limit]

    remaining_indices = list(range(len(raw_rows)))
    chosen_indices: list[int] = []
    seen_features: set[tuple[str, str]] = set()

    while remaining_indices and len(chosen_indices) < limit:
        best_index: int | None = None
        best_gain = -1
        best_penalty = inf

        for row_index in remaining_indices:
            eligible_features = {
                feature
                for feature in row_features[row_index]
                if feature[0] in eligible_feature_names
            }
            unseen_gain = len(eligible_features - seen_features)
            penalty = len(eligible_features & seen_features)

            if unseen_gain > best_gain or (unseen_gain == best_gain and penalty < best_penalty):
                best_index = row_index
                best_gain = unseen_gain
                best_penalty = penalty

        if best_index is None:
            break

        chosen_indices.append(best_index)
        seen_features.update(
            feature for feature in row_features[best_index] if feature[0] in eligible_feature_names
        )
        remaining_indices.remove(best_index)

        if best_gain <= 0 and len(chosen_indices) >= 1:
            break

    ordered_indices = sorted(chosen_indices)
    for row_index in range(len(raw_rows)):
        if len(ordered_indices) >= limit:
            break
        if row_index in chosen_indices:
            continue
        ordered_indices.append(row_index)

    return [raw_rows[row_index] for row_index in ordered_indices[:limit]]


async def list_scan_configs(session: AsyncSession, slug: str) -> list[ScanConfig]:
    project_id = await _get_project_id(session, slug)
    result = await session.execute(
        select(ScanConfig)
        .where(ScanConfig.project_id == project_id)
        .order_by(ScanConfig.created_at.desc())
    )
    return list(result.scalars().all())


async def get_scan_config(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> ScanConfig:
    project_id = await _get_project_id(session, slug)
    result = await session.execute(
        select(ScanConfig).where(ScanConfig.id == scan_id, ScanConfig.project_id == project_id)
    )
    config = result.scalar_one_or_none()
    if config is None:
        raise HTTPException(status_code=404, detail="Scan config not found")
    return config


async def create_scan_config(
    session: AsyncSession, slug: str, data: ScanConfigCreate
) -> ScanConfig:
    project_id = await _get_project_id(session, slug)
    await _verify_data_source(session, data.data_source_id)

    existing = await session.execute(
        select(ScanConfig).where(
            ScanConfig.project_id == project_id,
            ScanConfig.data_source_id == data.data_source_id,
            ScanConfig.name == data.name,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Scan config with this name already exists")

    _validate_metric_breakdown_selection(
        metric_breakdown_columns=data.metric_breakdown_columns,
        event_type_column=data.event_type_column,
        time_column=data.time_column,
    )

    config = ScanConfig(
        project_id=project_id,
        **data.model_dump(),
    )
    session.add(config)
    await session.commit()
    await session.refresh(config)
    return config


async def update_scan_config(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    data: ScanConfigUpdate,
) -> ScanConfig:
    config = await get_scan_config(session, slug, scan_id)
    update_dict = data.model_dump(exclude_unset=True)
    _validate_metric_breakdown_selection(
        metric_breakdown_columns=update_dict.get(
            "metric_breakdown_columns",
            config.metric_breakdown_columns,
        )
        or [],
        event_type_column=update_dict.get("event_type_column", config.event_type_column),
        time_column=update_dict.get("time_column", config.time_column),
    )
    for key, value in update_dict.items():
        setattr(config, key, value)
    await session.commit()
    await session.refresh(config)
    return config


async def preview_scan_config(
    session: AsyncSession,
    slug: str,
    data: ScanConfigPreviewRequest,
) -> ScanConfigPreviewResponse:
    await _get_project_id(session, slug)
    ds = await _verify_data_source(session, data.data_source_id)

    adapter: BaseAdapter | None = None
    try:
        adapter = _build_adapter(ds)
        adapter.test_connection()

        columns = adapter.get_columns(data.base_query)
        column_map = {column.name: column for column in columns}
        preview_fetch_limit = min(max(data.limit * 8, 50), 200)
        row_column_names, row_values = adapter.get_preview_rows(
            data.base_query,
            limit=preview_fetch_limit,
        )

        sampled_rows = [
            {name: value for name, value in zip(row_column_names, row, strict=False)}
            for row in row_values
        ]
        raw_rows = _select_diverse_preview_rows(columns, sampled_rows, limit=data.limit)
        preview_rows = [
            {
                name: _serialize_preview_value(
                    decode_json_path_value(value)
                    if _is_json_type(column_map[name].type_name)
                    else value
                )
                for name, value in row.items()
            }
            for row in raw_rows
        ]

        json_columns: list[ScanPreviewJsonColumnResponse] = []
        for column in columns:
            if not _is_json_type(column.type_name):
                continue

            sample_values_by_path: dict[str, list[str]] = {}
            seen_values_by_path: dict[str, set[str]] = {}
            for row in raw_rows:
                parsed_value = decode_json_path_value(row.get(column.name))
                for path, sample_value in flatten_json_paths(parsed_value):
                    sample_text = format_json_path_value(sample_value)
                    seen = seen_values_by_path.setdefault(path, set())
                    if sample_text in seen or len(seen) >= 3:
                        continue
                    seen.add(sample_text)
                    sample_values_by_path.setdefault(path, []).append(sample_text)

            json_columns.append(
                ScanPreviewJsonColumnResponse(
                    column=column.name,
                    paths=[
                        ScanPreviewJsonPathResponse(
                            full_path=f"{column.name}.{path}",
                            path=path,
                            sample_values=sample_values_by_path[path],
                        )
                        for path in sorted(sample_values_by_path)
                    ],
                )
            )

        return ScanConfigPreviewResponse(
            columns=[
                ScanPreviewColumnResponse(
                    name=column.name,
                    type_name=column.type_name,
                    is_nullable=column.is_nullable,
                )
                for column in columns
            ],
            rows=preview_rows,
            json_columns=json_columns,
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        if adapter is not None:
            adapter.close()


async def delete_scan_config(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> None:
    config = await get_scan_config(session, slug, scan_id)
    await session.delete(config)
    await session.commit()


async def trigger_scan(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> ScanJob:
    """Create a ScanJob and dispatch the Celery task."""
    config = await get_scan_config(session, slug, scan_id)

    job = ScanJob(
        scan_config_id=config.id,
        status=ScanJobStatus.pending.value,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)

    # Import here to avoid circular imports at module level
    from tripl.worker.tasks.scan import run_scan

    try:
        run_scan.delay(str(config.id), str(job.id))
    except Exception:
        job.status = ScanJobStatus.failed.value
        job.error_message = "Failed to dispatch task to worker (broker unavailable)"
        await session.commit()
        await session.refresh(job)
    return job


async def trigger_metrics_replay(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    data: ScanMetricsReplayRequest,
) -> ScanJob:
    """Create a ScanJob and dispatch metrics collection for an explicit window."""
    config = await get_scan_config(session, slug, scan_id)
    if not config.time_column or not config.interval:
        raise HTTPException(
            status_code=400,
            detail="Scan config requires time_column and interval to replay metrics",
        )

    job = ScanJob(
        scan_config_id=config.id,
        status=ScanJobStatus.pending.value,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)

    from tripl.worker.tasks.metrics import collect_metrics

    try:
        collect_metrics.delay(
            str(config.id),
            str(job.id),
            data.time_from.isoformat(),
            data.time_to.isoformat(),
        )
    except Exception:
        job.status = ScanJobStatus.failed.value
        job.error_message = "Failed to dispatch task to worker (broker unavailable)"
        await session.commit()
        await session.refresh(job)
    return job


async def list_scan_jobs(session: AsyncSession, slug: str, scan_id: uuid.UUID) -> list[ScanJob]:
    await get_scan_config(session, slug, scan_id)
    result = await session.execute(
        select(ScanJob).where(ScanJob.scan_config_id == scan_id).order_by(ScanJob.created_at.desc())
    )
    return list(result.scalars().all())


async def get_scan_job(
    session: AsyncSession,
    slug: str,
    scan_id: uuid.UUID,
    job_id: uuid.UUID,
) -> ScanJob:
    await get_scan_config(session, slug, scan_id)
    result = await session.execute(
        select(ScanJob).where(ScanJob.id == job_id, ScanJob.scan_config_id == scan_id)
    )
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=404, detail="Scan job not found")
    return job
