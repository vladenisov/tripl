from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from tripl.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
    pool_recycle=1800,
)
async_session = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncGenerator[AsyncSession]:
    async with async_session() as session:
        try:
            yield session
        except Exception:
            # A handler that raised after a partial flush would otherwise return
            # the connection to the pool with an aborted transaction; roll back
            # so the next checkout starts clean. Re-raise so error handling
            # (e.g. the global exception handler) still runs.
            await session.rollback()
            raise
