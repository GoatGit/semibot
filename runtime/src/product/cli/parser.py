from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Callable


Handler = Callable[[argparse.Namespace], int]


@dataclass(frozen=True)
class ProductCommandDefaults:
    db_path: str
    rules_path: str
    skills_path: str
    runtime_url: str


@dataclass(frozen=True)
class ProductCommandHandlers:
    init: Handler
    doctor: Handler
    chat: Handler
    run: Handler
    up: Handler
    down: Handler
    status: Handler
    logs: Handler
    upgrade: Handler


def register_product_command_parsers(
    subparsers: argparse._SubParsersAction[argparse.ArgumentParser],
    *,
    defaults: ProductCommandDefaults,
    handlers: ProductCommandHandlers,
) -> None:
    """Register stable product-facing commands without embedding business logic.

    This module intentionally owns parser composition only. Command execution
    continues to live in the existing runtime CLI until product commands are
    fully migrated into dedicated modules.
    """

    init_parser = subparsers.add_parser("init", help="Initialize local Semibot home")
    init_parser.add_argument("--db-path", default=defaults.db_path, help="SQLite DB path")
    init_parser.add_argument("--rules-path", default=defaults.rules_path, help="Rules path")
    init_parser.add_argument("--runtime-host", default="127.0.0.1", help="Runtime bind host")
    init_parser.add_argument("--runtime-port", type=int, default=8765, help="Runtime bind port")
    init_parser.add_argument("--api-port", type=int, default=3001, help="API port")
    init_parser.add_argument("--web-port", type=int, default=3000, help="Web port")
    init_parser.add_argument("--default-model", default=None, help="Default LLM model")
    init_parser.add_argument("--openai-api-key", default=None, help="Persist OPENAI_API_KEY into install env")
    init_parser.add_argument("--anthropic-api-key", default=None, help="Persist ANTHROPIC_API_KEY into install env")
    init_parser.add_argument("--update-manifest-url", default=None, help="Persist SEMIBOT_UPDATE_MANIFEST_URL into install config")
    init_parser.add_argument("--interactive", action="store_true", help="Prompt for missing values in a TTY session")
    init_parser.add_argument("--no-input", action="store_true", help="Disable interactive prompts")
    init_parser.add_argument("--force", action="store_true", help="Overwrite generated config files")
    init_parser.set_defaults(func=handlers.init)

    doctor_parser = subparsers.add_parser("doctor", help="Validate local runtime health")
    doctor_parser.add_argument("--db-path", default=defaults.db_path, help="SQLite DB path")
    doctor_parser.add_argument("--rules-path", default=defaults.rules_path, help="Rules path")
    doctor_parser.add_argument("--skills-path", default=defaults.skills_path, help="Skills path")
    doctor_parser.set_defaults(bootstrap_runtime_home=False)
    doctor_parser.set_defaults(func=handlers.doctor)

    chat_parser = subparsers.add_parser("chat", help="Start CLI chat mode")
    chat_parser.add_argument("--db-path", default=defaults.db_path, help="SQLite DB path")
    chat_parser.add_argument("--rules-path", default=defaults.rules_path, help="Rules path")
    chat_parser.add_argument("--agent-id", default="semibot", help="Agent ID")
    chat_parser.add_argument("--session-id", default=None, help="Session ID override")
    chat_parser.add_argument("--model", default=None, help="Model override")
    chat_parser.add_argument("--system-prompt", default=None, help="Agent system prompt override")
    chat_parser.add_argument(
        "--server-url",
        default=defaults.runtime_url,
        help="Runtime service base URL",
    )
    chat_parser.add_argument("--message", default=None, help="Run one chat turn and exit")
    chat_parser.add_argument(
        "--json",
        action="store_true",
        help="Print assistant result in JSON for each turn",
    )
    chat_parser.set_defaults(func=handlers.chat)

    run_parser = subparsers.add_parser("run", help="Run a single task")
    run_parser.add_argument("task", help="Task prompt")
    run_parser.add_argument("--agent-id", default="semibot", help="Agent ID")
    run_parser.add_argument("--session-id", default=None, help="Session ID override")
    run_parser.add_argument(
        "--server-url",
        default=defaults.runtime_url,
        help="Runtime service base URL",
    )
    run_parser.set_defaults(func=handlers.run)

    up_parser = subparsers.add_parser("up", help="Start local Semibot services")
    up_parser.add_argument(
        "--name-prefix",
        default=None,
        help="Process name prefix (default: project-isolated)",
    )
    up_parser.add_argument("--api-port", type=int, default=None, help="API port (default: config or built-in)")
    up_parser.add_argument("--web-port", type=int, default=None, help="Web port (default: config or built-in)")
    up_parser.add_argument("--runtime-host", default=None, help="Runtime bind host (default: config or built-in)")
    up_parser.add_argument("--runtime-port", type=int, default=None, help="Runtime bind port (default: config or built-in)")
    up_parser.add_argument("--runtime-name", default=None, help="Runtime process name override")
    up_parser.add_argument("--runtime-db-path", default=None, help="Runtime SQLite DB path (default: config or built-in)")
    up_parser.add_argument("--runtime-rules-path", default=None, help="Runtime rules path (default: config or built-in)")
    up_parser.add_argument("--no-wait", dest="wait_for_health", action="store_false", help="Return immediately after spawning services")
    up_parser.add_argument("--health-timeout", type=float, default=30.0, help="Health wait timeout seconds")
    up_parser.add_argument("--no-runtime", dest="with_runtime", action="store_false", help="Do not manage runtime")
    up_parser.set_defaults(with_runtime=True)
    up_parser.set_defaults(wait_for_health=True)
    up_parser.set_defaults(func=handlers.up)

    down_parser = subparsers.add_parser("down", help="Stop local Semibot services")
    down_parser.add_argument(
        "--name-prefix",
        default=None,
        help="Process name prefix (default: project-isolated)",
    )
    down_parser.add_argument("--api-port", type=int, default=None, help="API port (default: config or built-in)")
    down_parser.add_argument("--web-port", type=int, default=None, help="Web port (default: config or built-in)")
    down_parser.add_argument("--runtime-port", type=int, default=None, help="Runtime bind port (default: config or built-in)")
    down_parser.add_argument("--runtime-name", default=None, help="Runtime process name override")
    down_parser.add_argument("--no-runtime", dest="with_runtime", action="store_false", help="Do not manage runtime")
    down_parser.set_defaults(with_runtime=True)
    down_parser.set_defaults(func=handlers.down)

    status_parser = subparsers.add_parser("status", help="Show local Semibot service status")
    status_parser.add_argument(
        "--name-prefix",
        default=None,
        help="Process name prefix (default: project-isolated)",
    )
    status_parser.add_argument("--runtime-name", default=None, help="Runtime process name override")
    status_parser.add_argument("--api-port", type=int, default=None, help="API port (default: config or built-in)")
    status_parser.add_argument("--web-port", type=int, default=None, help="Web port (default: config or built-in)")
    status_parser.add_argument("--runtime-port", type=int, default=None, help="Runtime bind port (default: config or built-in)")
    status_parser.add_argument("--no-runtime", dest="with_runtime", action="store_false", help="Do not inspect runtime")
    status_parser.set_defaults(with_runtime=True)
    status_parser.set_defaults(bootstrap_runtime_home=False)
    status_parser.set_defaults(func=handlers.status)

    logs_parser = subparsers.add_parser("logs", help="Show local service logs")
    logs_parser.add_argument("service", nargs="?", default="all", help="runtime, api, web, or all")
    logs_parser.add_argument("--lines", type=int, default=100, help="Number of lines to tail per log file")
    logs_parser.add_argument(
        "--name-prefix",
        default=None,
        help="Process name prefix (default: project-isolated)",
    )
    logs_parser.add_argument("--runtime-name", default=None, help="Runtime process name override")
    logs_parser.add_argument("--api-port", type=int, default=None, help="API port (default: config or built-in)")
    logs_parser.add_argument("--web-port", type=int, default=None, help="Web port (default: config or built-in)")
    logs_parser.add_argument("--runtime-port", type=int, default=None, help="Runtime bind port (default: config or built-in)")
    logs_parser.add_argument("--no-runtime", dest="with_runtime", action="store_false", help="Do not inspect runtime")
    logs_parser.set_defaults(with_runtime=True)
    logs_parser.set_defaults(bootstrap_runtime_home=False)
    logs_parser.set_defaults(func=handlers.logs)

    upgrade_parser = subparsers.add_parser("upgrade", help="Install a release, switch active version, or upgrade from a release URL")
    upgrade_parser.add_argument("--release-dir", default=None, help="Release directory to install")
    upgrade_parser.add_argument("--release-url", default=None, help="Release archive URL to download and install")
    upgrade_parser.add_argument("--manifest-url", default=None, help="Release manifest URL to resolve latest release metadata")
    upgrade_parser.add_argument("--sha256", default=None, help="Expected sha256 for downloaded release archive")
    upgrade_parser.add_argument("--version", default=None, help="Installed version to switch to, or expected release version")
    upgrade_parser.set_defaults(bootstrap_runtime_home=False)
    upgrade_parser.set_defaults(func=handlers.upgrade)
