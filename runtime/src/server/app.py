"""FastAPI application factory for the runtime server."""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.server.routes import router
from src.utils.logging import get_logger

logger = get_logger(__name__)

# Load .env.local from project root (two levels up from runtime/src/server/)
_project_root = Path(__file__).resolve().parents[3]
_env_local = _project_root / ".env.local"
if _env_local.exists():
    load_dotenv(_env_local, override=True)
    logger.info("Loaded environment from %s", _env_local)


def _create_llm_provider():
    """Create LLM provider from environment variables."""
    from src.llm.base import LLMConfig
    from src.llm.openai_provider import OpenAIProvider

    # Prefer CUSTOM_LLM (DeepSeek etc.), fall back to OPENAI
    api_key = os.getenv("CUSTOM_LLM_API_KEY") or os.getenv("OPENAI_API_KEY")
    base_url = os.getenv("CUSTOM_LLM_API_BASE_URL") or os.getenv("OPENAI_API_BASE_URL")
    model = os.getenv("CUSTOM_LLM_MODEL_NAME") or os.getenv("OPENAI_MODEL", "gpt-4o")

    if not api_key:
        logger.warning("No LLM API key configured – llm_provider will be None")
        return None

    # OpenAI SDK expects base_url to end with /v1
    if base_url and not base_url.rstrip("/").endswith("/v1"):
        base_url = base_url.rstrip("/") + "/v1"

    # OpenAI-compatible provider works for DeepSeek, ChatAnywhere, etc.
    config = LLMConfig(
        model=model,
        api_key=api_key,
        base_url=base_url if base_url else None,
    )
    provider = OpenAIProvider(config)
    logger.info("LLM provider initialized", extra={"model": model, "base_url": base_url})
    return provider


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown hooks."""
    # --- Startup ---
    logger.info("Runtime server starting up")

    # Bootstrap skill registry
    from src.skills.bootstrap import create_default_registry

    registry = create_default_registry()
    app.state.skill_registry = registry

    # Initialize LLM provider
    app.state.llm_provider = _create_llm_provider()

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
