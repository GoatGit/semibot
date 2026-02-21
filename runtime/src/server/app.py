"""FastAPI application factory for the runtime server."""

import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.server.routes import router
from src.server.middleware import TraceMiddleware
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
    timeout = int(os.getenv("LLM_TIMEOUT", "120"))
    config = LLMConfig(
        model=model,
        api_key=api_key,
        base_url=base_url if base_url else None,
        timeout=timeout,
    )
    provider = OpenAIProvider(config)
    logger.info("LLM provider initialized", extra={"model": model, "base_url": base_url})
    return provider


async def _create_memory_system():
    """Create MemorySystem with graceful degradation.

    Returns None if Redis or PostgreSQL is unavailable so the runtime
    can still serve requests without memory capabilities.
    """
    from src.memory import (
        EmbeddingService,
        LongTermMemory,
        MemorySystem,
        OpenAIEmbeddingProvider,
        ShortTermMemory,
    )

    redis_url = os.getenv("REDIS_URL")
    database_url = os.getenv("DATABASE_URL")
    embedding_api_key = os.getenv("OPENAI_API_KEY") or os.getenv("CUSTOM_LLM_API_KEY")
    embedding_base_url = os.getenv("OPENAI_API_BASE_URL") or os.getenv("CUSTOM_LLM_API_BASE_URL")

    if not redis_url and not database_url:
        logger.info("Memory system disabled: REDIS_URL and DATABASE_URL not configured")
        return None

    # --- Short-term memory (Redis) ---
    short_term = None
    if redis_url:
        try:
            short_term = ShortTermMemory(redis_url=redis_url)
            if not await short_term.health_check():
                raise RuntimeError("Short-term memory health check failed")
            logger.info("Short-term memory (Redis) initialized")
        except Exception as e:
            logger.warning("Short-term memory unavailable, continuing without it: %s", e)
            short_term = None

    # --- Embedding service (required for long-term memory) ---
    embedding_service = None
    if embedding_api_key:
        kwargs: dict = {"api_key": embedding_api_key}
        if embedding_base_url:
            base = embedding_base_url.rstrip("/")
            if not base.endswith("/v1"):
                base += "/v1"
            kwargs["base_url"] = base
        embedding_service = EmbeddingService(
            provider=OpenAIEmbeddingProvider(**kwargs),
        )

    # --- Long-term memory (PostgreSQL + pgvector) ---
    long_term = None
    if database_url and embedding_service:
        try:
            long_term = LongTermMemory(
                database_url=database_url,
                embedding_service=embedding_service,
            )
            if not await long_term.health_check():
                raise RuntimeError("Long-term memory health check failed")
            logger.info("Long-term memory (pgvector) initialized")
        except Exception as e:
            logger.warning("Long-term memory unavailable, continuing without it: %s", e)
            long_term = None
    elif database_url and not embedding_service:
        logger.info("Long-term memory disabled: no embedding API key configured")

    if not short_term and not long_term:
        logger.info("Memory system disabled: no backends available")
        return None

    memory = MemorySystem(short_term=short_term, long_term=long_term)
    logger.info(
        "Memory system initialized",
        extra={"short_term": short_term is not None, "long_term": long_term is not None},
    )
    return memory


async def _shutdown_memory_system(memory_system) -> None:
    """Gracefully close memory system connections."""
    if memory_system is None:
        return
    try:
        if memory_system.short_term:
            await memory_system.short_term.close()
        if memory_system.long_term:
            await memory_system.long_term.close()
        logger.info("Memory system connections closed")
    except Exception as e:
        logger.warning("Error closing memory system: %s", e)


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

    # Initialize FileManager and inject into CodeExecutorTool
    from src.skills.code_executor import set_file_manager
    from src.storage.file_manager import FileManager

    file_manager = FileManager()
    file_manager.start_cleanup_loop()
    app.state.file_manager = file_manager
    set_file_manager(file_manager)

    # Initialize Memory System (graceful degradation: None if connections fail)
    app.state.memory_system = await _create_memory_system()

    logger.info("Runtime server ready")
    yield

    # --- Shutdown ---
    logger.info("Runtime server shutting down")
    file_manager.stop_cleanup_loop()
    await _shutdown_memory_system(app.state.memory_system)


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

    # 请求追踪（X-Request-ID 透传）
    app.add_middleware(TraceMiddleware)

    # Mount routes
    app.include_router(router)

    return app
