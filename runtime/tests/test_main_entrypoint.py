from __future__ import annotations

from src import main as main_module


def test_main_uses_execution_plane_mode_with_vm_env(monkeypatch):
    monkeypatch.setenv("VM_USER_ID", "user-1")
    monkeypatch.setenv("VM_TOKEN", "token-1")
    monkeypatch.setattr(main_module.sys, "argv", ["src.main"])

    called = {"async_run": False}

    async def fake_run_execution_plane() -> None:
        return None

    def fake_asyncio_run(coro):  # noqa: ANN001
        called["async_run"] = True
        coro.close()
        return None

    monkeypatch.setattr("src.execution_plane.run_execution_plane", fake_run_execution_plane)
    monkeypatch.setattr(main_module.asyncio, "run", fake_asyncio_run)

    main_module.main()
    assert called["async_run"] is True


def test_main_uses_cli_mode_when_args_present(monkeypatch):
    monkeypatch.delenv("VM_USER_ID", raising=False)
    monkeypatch.delenv("VM_TOKEN", raising=False)
    monkeypatch.setattr(main_module.sys, "argv", ["python", "-m", "src.main", "chat"])

    called = {"cli": False}

    def fake_cli_main() -> None:
        called["cli"] = True

    monkeypatch.setattr("src.cli.main", fake_cli_main)

    main_module.main()
    assert called["cli"] is True
