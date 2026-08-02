from fastapi import APIRouter

from tripl.schemas.system import WorkerHealth
from tripl.services import worker_health_service

router = APIRouter(tags=["system"])


@router.get("/system/worker-health", response_model=WorkerHealth)
async def get_worker_health() -> WorkerHealth:
    """Report whether the async pipeline (beat + worker) is alive.

    Deliberately not owner-gated: the person watching a scan that never
    finishes is whoever is on the page, not necessarily an owner.
    """
    return await worker_health_service.get_worker_health()
