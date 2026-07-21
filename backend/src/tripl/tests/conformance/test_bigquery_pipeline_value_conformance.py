"""Credentialed full worker-pipeline conformance against real BigQuery."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.adapters.bigquery import BigQueryAdapter
from tripl.tests.conformance import test_pipeline_conformance as pipeline
from tripl.tests.conformance.bigquery_live import new_adapter, unavailable
from tripl.tests.conformance.bigquery_values import PIPELINE_BASE
from tripl.tests.conformance.conftest import PipelineWarehouse

pytestmark = pytest.mark.bigquery_pipeline

_REQUIRED_ENV = "TRIPL_BQ_PIPELINE_REQUIRED"


def _new_adapter() -> BigQueryAdapter:
    return new_adapter(required_env=_REQUIRED_ENV)


@pytest.fixture(scope="session")
def bq_pipeline_run(app_db: sessionmaker[Session]) -> Iterator[pipeline.PipelineRun]:
    probe: BigQueryAdapter | None = None
    try:
        try:
            probe = _new_adapter()
            probe.test_connection()
            probe.get_columns(PIPELINE_BASE)
        except Exception as exc:  # noqa: BLE001 - cloud/auth failure means unavailable
            unavailable(str(exc), required_env=_REQUIRED_ENV)
    finally:
        if probe is not None:
            probe.close()

    warehouse = PipelineWarehouse(
        db_type="bigquery",
        new_adapter=_new_adapter,
        events_query=f"SELECT ts, event_name, user_id FROM ({PIPELINE_BASE})",
        facts_query=PIPELINE_BASE,
    )
    yield pipeline._run_pipeline(app_db, warehouse)  # noqa: SLF001


def test_full_bigquery_pipeline_matches_the_reference(
    bq_pipeline_run: pipeline.PipelineRun,
) -> None:
    """Run every value/idempotency/anomaly assertion used by PostgreSQL/ClickHouse."""
    run = bq_pipeline_run
    pipeline.test_scan_generates_events_from_the_warehouse(run)
    pipeline.test_event_metrics_match_floor_to_bucket(run)
    pipeline.test_event_metrics_land_on_the_fixtures_buckets(run)
    pipeline.test_replaying_the_same_window_is_idempotent(run)
    pipeline.test_the_replay_was_actually_chunked(run)
    pipeline.test_fact_single_sum_matches_the_reference(run)
    pipeline.test_fact_single_count_and_distinct_match_the_reference(run)
    pipeline.test_fact_ratio_matches_the_reference(run)
    pipeline.test_fact_ratio_drops_the_divide_by_zero_bucket(run)
    pipeline.test_fact_breakdown_rows_match_the_reference(run)
    pipeline.test_batched_fact_collection_reproduces_the_per_metric_values(run)
    pipeline.test_the_batch_actually_collected_every_metric(run)
    pipeline.test_event_composition_single_matches_the_event_metrics(run)
    pipeline.test_event_composition_ratio_matches_the_reference(run)
    pipeline.test_per_distinct_user_matches_the_reference(run)
    pipeline.test_the_event_spike_is_detected(run)
    for metric in (
        pipeline.FACT_SUM,
        pipeline.FACT_COUNT,
        pipeline.FACT_RATIO,
        pipeline.COMP_SINGLE,
        pipeline.COMP_RATIO,
    ):
        pipeline.test_the_metric_spike_is_detected(run, metric)
    pipeline.test_a_flat_series_is_not_an_anomaly(run)
