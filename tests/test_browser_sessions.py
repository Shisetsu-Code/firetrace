import pytest

from firetrace.browser_sessions import BrowserSessions
from test_local_browser_integration import server


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    monkeypatch.setenv('FIRETRACE_HEADLESS', '1')
    manager = BrowserSessions(profile_root=tmp_path / 'profiles', max_browsers=2)
    yield manager
    manager.close()


def test_isolation_routing_limit_and_manual_close(sessions, server):
    assert sessions.status()['browsers'] == []
    a = sessions.create()['browser_id']
    b = sessions.create()['browser_id']
    sessions.select(a)
    sessions.context.add_cookies([{'name': 'private', 'value': 'a', 'url': 'https://example.com'}])
    sessions.open(f'http://127.0.0.1:{server}/')
    sessions.page.evaluate("localStorage.setItem('private', 'a')")
    sessions.select(b)
    assert sessions.context.cookies() == []
    sessions.open(f'http://127.0.0.1:{server}/')
    assert sessions.page.evaluate("localStorage.getItem('private')") is None
    with pytest.raises(ValueError, match='browser_id'):
        sessions.select()
    with pytest.raises(ValueError, match='limit'):
        sessions.create()
    sessions.select(a)
    sessions.browser.close()
    assert sessions.list_browsers()['browsers'][0]['open'] is False
    with pytest.raises(ValueError, match='closed'):
        sessions.select(a)
    sessions.reopen(a)
    sessions.select(a)
    assert sessions.context.cookies() == []
    sessions.select(b)
    assert sessions.browser.is_connected()


def test_last_page_closed_and_unknown_id_never_targets_other_window(sessions):
    a = sessions.create()['browser_id']
    b = sessions.create()['browser_id']
    sessions.select(a)
    sessions.page.close()
    assert sessions.list_browsers()['active_count'] == 1
    with pytest.raises(ValueError, match='closed'):
        sessions.select(a)
    with pytest.raises(ValueError, match='Unknown'):
        sessions.select('not-real')
    sessions.reopen(a)
    assert sessions.list_browsers()['active_count'] == 2
    sessions.close_browser(a)
    sessions.close_browser(a)
    sessions.select(b)
    assert not sessions.page.is_closed()


def test_persistent_profile_survives_worker_restart(tmp_path, monkeypatch):
    monkeypatch.setenv('FIRETRACE_HEADLESS', '1')
    root = tmp_path / 'profiles'
    first = BrowserSessions(profile_root=root)
    try:
        a = first.create(mode='persistent', profile='project-a')['browser_id']
        first.select(a)
        first.context.add_cookies([{'name': 'saved', 'value': 'yes', 'url': 'https://example.com', 'expires': 2000000000}])
        with pytest.raises(ValueError, match='already open'):
            first.create(mode='persistent', profile='project-a')
    finally:
        first.close()
    second = BrowserSessions(profile_root=root)
    try:
        assert second.list_browsers()['profiles'] == ['project-a']
        a = second.create(mode='persistent', profile='project-a')['browser_id']
        second.select(a)
        assert second.context.cookies()[0]['value'] == 'yes'
    finally:
        second.close()


def test_invalid_profiles_and_legacy_recovery(sessions):
    for name in ['../escape', 'A', 'con', '', 'a/b']:
        with pytest.raises(ValueError):
            sessions.create(mode='persistent', profile=name)
    sessions.select(allow_create=True)
    first = sessions.status()['browsers'][0]['browser_id']
    sessions.browser.close()
    sessions.select(allow_create=True)
    assert sessions.status()['browsers'][0]['browser_id'] == first
    assert sessions.browser.is_connected()
    sessions.close_browser(first)
    assert sessions.status()['connected'] is True
    assert sessions.list_browsers()['active_count'] == 0


def test_worker_routes_commands_and_screenshots(sessions):
    from firetrace.worker import Worker
    from firetrace.cloudflare_agent import CloudflareFiretraceAgent
    worker = Worker.__new__(Worker)
    worker.backend = sessions
    a = worker.execute({'action': 'browser_create', 'args': {}})['data']['browser_id']
    b = worker.execute({'action': 'browser_create', 'args': {}})['data']['browser_id']
    sessions.select(a)
    sessions.page.set_content('<title>A</title>')
    sessions.select(b)
    sessions.page.set_content('<title>B</title>')
    worker.execute({'action': 'wait', 'args': {'browser_id': a, 'ms': 0}})
    assert sessions.page.title() == 'A'
    with pytest.raises(ValueError, match='browser_id'):
        worker.execute({'action': 'click', 'args': {'x': 0, 'y': 0}})
    agent = CloudflareFiretraceAgent.__new__(CloudflareFiretraceAgent)
    agent.worker = worker
    agent.agent_id = 'test'
    class Socket:
        def send(self, data):
            assert isinstance(data, bytes)
            assert len(data) > 1000
    agent.send_screenshot(Socket(), 'test', {'browser_id': b})
    assert sessions.page.title() == 'B'
