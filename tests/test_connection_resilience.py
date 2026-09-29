import json
import threading
import time
from unittest.mock import Mock

from websockets.sync.server import serve
from firetrace.cloudflare_agent import CloudflareFiretraceAgent


def test_heartbeat_survives_busy_browser_and_reconnect_preserves_worker():
    received = threading.Event()
    completed = threading.Event()
    connections = []

    def handler(ws):
        connections.append(1)
        ws.send(json.dumps({'type': 'capabilities', 'heartbeat': 'hibernation-heartbeat'}))
        if len(connections) == 1:
            ws.send(json.dumps({'type': 'command', 'command': {'id': 'slow'}}))
            for raw in ws:
                if raw == 'firetrace:ping':
                    received.set()
                    ws.close(1012, 'test restart')
                    return
        else:
            completed.set()
            agent.stop_event.set()

    with serve(handler, '127.0.0.1', 0) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        agent = CloudflareFiretraceAgent.__new__(CloudflareFiretraceAgent)
        agent.base_url = f'http://127.0.0.1:{server.socket.getsockname()[1]}'
        agent.agent_id, agent.token = 'test', 'test'
        agent.stop_event = threading.Event()
        agent.HEARTBEAT_INTERVAL = 0.05
        agent.worker = Mock()
        agent.worker.backend.status.return_value = {'backend': 'test'}
        worker = agent.worker
        # Real network heartbeat must arrive while this browser operation blocks.
        agent.handle_command = lambda ws, cmd: received.wait(0.5)
        runner = threading.Thread(target=agent.run_forever, daemon=True)
        runner.start()
        try:
            assert received.wait(1), 'Browser execution starved the heartbeat'
            assert completed.wait(4), 'Agent did not reconnect after server restart'
            assert agent.worker is worker
        finally:
            agent.stop_event.set()
            runner.join(5)
            server.shutdown()
        assert not runner.is_alive()


def test_backoff_resets_after_stable_connection():
    agent = CloudflareFiretraceAgent.__new__(CloudflareFiretraceAgent)
    assert agent.reconnect_delay(12, 120, jitter=1) == 1
    assert agent.reconnect_delay(12, 1, jitter=1) > 12
    assert agent.reconnect_delay(30, 1, jitter=1) <= 30
