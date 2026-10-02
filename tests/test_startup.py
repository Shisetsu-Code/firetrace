import os
import subprocess
import threading
from unittest.mock import Mock

from firetrace import launcher, worker


def test_local_transport_is_default_and_needs_no_cloudflare_credentials(monkeypatch):
    for key in (
        "CF_CONTROL_URL",
        "CF_CONTROL_TOKEN",
        "FIRETRACE_CONTROL_URL",
        "FIRETRACE_CONTROL_TOKEN",
        "FIRETRACE_TRANSPORT",
    ):
        monkeypatch.delenv(key, raising=False)

    run_local = Mock()
    monkeypatch.setattr(launcher, "load_user_environment", lambda: None)
    monkeypatch.setattr(launcher, "run_local_mcp", run_local)

    assert launcher.main() == 0
    run_local.assert_called_once()


def test_explicit_cloudflare_transport_uses_persisted_credentials(monkeypatch):
    from firetrace import cloudflare_agent

    for key in (
        "CF_CONTROL_URL",
        "CF_CONTROL_TOKEN",
        "FIRETRACE_CONTROL_URL",
        "FIRETRACE_CONTROL_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)

    monkeypatch.setenv("FIRETRACE_TRANSPORT", "cloudflare")
    monkeypatch.setattr(
        launcher,
        "load_user_environment",
        lambda: os.environ.update(
            CF_CONTROL_URL="https://control.example",
            CF_CONTROL_TOKEN="test-token",
        ),
    )
    chrome = Mock()
    connect = Mock()
    monkeypatch.setattr(launcher, "ensure_chrome_cdp", chrome)
    monkeypatch.setattr(cloudflare_agent, "main", connect)

    assert launcher.main() == 0
    connect.assert_called_once()
    chrome.assert_called_once()


def test_explicit_cloudflare_transport_requires_credentials(monkeypatch):
    monkeypatch.setenv("FIRETRACE_TRANSPORT", "cloudflare")
    for key in (
        "CF_CONTROL_URL",
        "CF_CONTROL_TOKEN",
        "FIRETRACE_CONTROL_URL",
        "FIRETRACE_CONTROL_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)

    monkeypatch.setattr(launcher, "load_user_environment", lambda: None)
    monkeypatch.setattr(launcher, "ensure_chrome_cdp", Mock())

    assert launcher.main() == 1


def test_legacy_git_subprocess_is_noninteractive_and_has_no_window(monkeypatch):
    run = Mock(return_value=subprocess.CompletedProcess([], 0, "", ""))
    monkeypatch.setattr(worker.subprocess, "run", run)
    worker.git("status")
    kwargs = run.call_args.kwargs
    assert kwargs["stdin"] == subprocess.DEVNULL
    assert kwargs["env"]["GIT_TERMINAL_PROMPT"] == "0"
    if os.name == "nt":
        assert kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW


def test_connected_wss_loop_does_not_poll_github(monkeypatch):
    from firetrace import cloudflare_agent

    agent = cloudflare_agent.CloudflareFiretraceAgent.__new__(
        cloudflare_agent.CloudflareFiretraceAgent
    )
    agent.base_url = "https://control.example"
    agent.agent_id = "firetrace"
    agent.token = "test"
    agent.stop_event = threading.Event()
    agent.worker = Mock()
    agent.worker.backend.status.return_value = {"backend": "test"}
    agent.send_state = Mock()
    agent.send_json = Mock()
    agent.poll_repo_inbox = Mock(side_effect=AssertionError("no git polling during WSS"))

    class Socket:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def recv(self, timeout):
            agent.stop_event.set()
            raise TimeoutError

    monkeypatch.setattr(cloudflare_agent, "connect", lambda *a, **k: Socket())
    agent.session()
    agent.poll_repo_inbox.assert_not_called()
