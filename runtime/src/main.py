def main() -> None:
    """Single-process local runtime entrypoint.

    V2 local mode no longer requires Control Plane auth/WebSocket bootstrap.
    This command simply forwards to the Semibot CLI.
    """
    from src.cli import main as cli_main

    cli_main()


if __name__ == "__main__":
    main()
