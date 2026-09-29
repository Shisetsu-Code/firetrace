import os
import subprocess
import threading
from unittest.mock import Mock

from firetrace import launcher, worker


def test_windows_packaged_browser_uses_shared_cache(monkeypatch, tmp_path):
    from firetrace import runtime
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path))
    monkeypatch.delenv('PLAYWRIGHT_BROWSERS_PATH', raising=False)
    runtime.configure_browser_cache()
    if os.name == 'nt':
        assert os.environ['PLAYWRIGHT_BROWSERS_PATH'] == str(tmp_path / 'ms-playwright')


def test_launcher_reads_persisted_credentials_before_selecting_transport(monkeypatch):
    from firetrace import cloudflare_agent
    for key in ('CF_CONTROL_URL', 'CF_CONTROL_TOKEN', 'FIRETRACE_CONTROL_URL', 'FIRETRACE_CONTROL_TOKEN'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(launcher, 'load_user_environment', lambda: os.environ.update(
        CF_CONTROL_URL='https://control.example', CF_CONTROL_TOKEN='test-token'), raising=False)
    chrome = Mock()
    connect = Mock()
    monkeypatch.setattr(launcher, 'ensure_chrome_cdp', chrome)
    monkeypatch.setattr(cloudflare_agent, 'main', connect)
    monkeypatch.setattr(launcher, 'run', Mock(side_effect=AssertionError('startup must not run git')))
    monkeypatch.setattr(launcher, 'ensure_cloudflare_http_bridge', Mock(side_effect=AssertionError('startup must not deploy')), raising=False)
    assert launcher.main() == 0
    connect.assert_called_once()
    chrome.assert_not_called()


def test_missing_credentials_never_silently_starts_git_polling(monkeypatch):
    for key in ('CF_CONTROL_URL', 'CF_CONTROL_TOKEN', 'FIRETRACE_CONTROL_URL', 'FIRETRACE_CONTROL_TOKEN', 'FIRETRACE_TRANSPORT'):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(launcher, 'load_user_environment', lambda: None, raising=False)
    monkeypatch.setattr(launcher, 'run', Mock())
    monkeypatch.setattr(launcher, 'ensure_cloudflare_http_bridge', Mock(), raising=False)
    monkeypatch.setattr(launcher, 'ensure_chrome_cdp', Mock())
    monkeypatch.setattr(worker, 'Worker', Mock(side_effect=AssertionError('must not start fallback')))
    assert launcher.main() == 1


def test_legacy_git_subprocess_is_noninteractive_and_has_no_window(monkeypatch):
    run = Mock(return_value=subprocess.CompletedProcess([], 0, '', ''))
    monkeypatch.setattr(worker.subprocess, 'run', run)
    worker.git('status')
    kwargs = run.call_args.kwargs
    assert kwargs['stdin'] == subprocess.DEVNULL
    assert kwargs['env']['GIT_TERMINAL_PROMPT'] == '0'
    if os.name == 'nt':
        assert kwargs['creationflags'] & subprocess.CREATE_NO_WINDOW


def test_connected_wss_loop_does_not_poll_github(monkeypatch):
    from firetrace import cloudflare_agent
    agent = cloudflare_agent.CloudflareFiretraceAgent.__new__(cloudflare_agent.CloudflareFiretraceAgent)
    agent.base_url='https://control.example'
    agent.agent_id='firetrace'
    agent.token='test'
    agent.stop_event=threading.Event()
    agent.worker=Mock()
    agent.worker.backend.status.return_value={'backend':'test'}
    agent.send_state=Mock()
    agent.send_json=Mock()
    agent.poll_repo_inbox=Mock(side_effect=AssertionError('no git polling during WSS'))
    class Socket:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def recv(self,timeout):
            agent.stop_event.set()
            raise TimeoutError
    monkeypatch.setattr(cloudflare_agent,'connect',lambda *a,**k:Socket())
    agent.session()
    agent.poll_repo_inbox.assert_not_called()


def test_unchanged_browser_state_is_not_retransmitted():
    from firetrace.cloudflare_agent import CloudflareFiretraceAgent
    agent=CloudflareFiretraceAgent.__new__(CloudflareFiretraceAgent)
    agent.agent_id='test'
    agent.worker=Mock()
    agent.worker.backend.status.return_value={'browsers':[], 'connected':True}
    agent.send_json=Mock()
    agent.send_state(Mock())
    agent.send_state(Mock(),command_id='another')
    assert agent.send_json.call_count==1
    agent.worker.backend.status.return_value={'browsers':[{'open':True}], 'connected':True}
    agent.send_state(Mock())
    assert agent.send_json.call_count==2


def test_optimized_heartbeat_uses_hibernation_ping_not_hello():
    from firetrace.cloudflare_agent import CloudflareFiretraceAgent
    agent=CloudflareFiretraceAgent.__new__(CloudflareFiretraceAgent)
    agent.agent_id='test'
    agent.send_json=Mock()
    agent.send_state=Mock()
    socket=Mock()
    agent.heartbeat(socket, optimized=True)
    socket.send.assert_called_once_with('firetrace:ping')
    agent.send_json.assert_not_called()
