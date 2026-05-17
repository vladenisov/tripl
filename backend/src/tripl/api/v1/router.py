from fastapi import APIRouter, Depends

from tripl.api.deps import get_current_user
from tripl.api.v1.activity import router as activity_router
from tripl.api.v1.alerting import router as alerting_router
from tripl.api.v1.auth import router as auth_router
from tripl.api.v1.data_sources import router as data_sources_router
from tripl.api.v1.event_types import router as event_types_router
from tripl.api.v1.events import router as events_router
from tripl.api.v1.fields import router as fields_router
from tripl.api.v1.meta_fields import router as meta_fields_router
from tripl.api.v1.metrics import router as metrics_router
from tripl.api.v1.plan_revisions import router as plan_revisions_router
from tripl.api.v1.project_anomaly_settings import router as project_anomaly_settings_router
from tripl.api.v1.projects import router as projects_router
from tripl.api.v1.relations import router as relations_router
from tripl.api.v1.scans import router as scans_router
from tripl.api.v1.variables import router as variables_router

router = APIRouter(prefix="/api/v1")
protected_dependencies = [Depends(get_current_user)]

router.include_router(auth_router)
router.include_router(activity_router, dependencies=protected_dependencies)
router.include_router(projects_router, dependencies=protected_dependencies)
router.include_router(project_anomaly_settings_router, dependencies=protected_dependencies)
router.include_router(alerting_router, dependencies=protected_dependencies)
router.include_router(event_types_router, dependencies=protected_dependencies)
router.include_router(fields_router, dependencies=protected_dependencies)
router.include_router(relations_router, dependencies=protected_dependencies)
router.include_router(meta_fields_router, dependencies=protected_dependencies)
router.include_router(events_router, dependencies=protected_dependencies)
router.include_router(variables_router, dependencies=protected_dependencies)
router.include_router(data_sources_router, dependencies=protected_dependencies)
router.include_router(scans_router, dependencies=protected_dependencies)
router.include_router(metrics_router, dependencies=protected_dependencies)
router.include_router(plan_revisions_router, dependencies=protected_dependencies)
