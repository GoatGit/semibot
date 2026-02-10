"""FastAPI application factory for the runtime server."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.server.routes import router
from src.utils.logging import get_logger

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown hooks."""
    # --- Startup ---
    logger.info("Runtime server starting up")

    # Bootstrap skill registry
    from src.skills.bootstrap import create_default_registry

    registry = create_default_registry()
    app.state.skill_registry = registry

    logger.info("Runtime server ready")
    yield

    # --- Shutdown ---
    logger.info("Runtime server shutting down")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Semibot Runtime",
        description="Python runtime orchestrator for Semibot agents",
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS — allow the API server to call us
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount routes
    app.include_router(router)

    return app
