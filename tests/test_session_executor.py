import threading
import pytest


def test_executors_overlap_and_keep_thread_affinity():
    from firetrace.session_executor import SessionExecutor
    barrier = threading.Barrier(2)
    class Runtime:
        def __init__(self): self.owner = threading.get_ident()
        def execute(self, action, args):
            assert threading.get_ident() == self.owner
            if action == 'barrier': barrier.wait(3)
            return {'owner': self.owner, 'value': args.get('value')}
        def status(self): return {'open': True}
        def close(self): assert threading.get_ident() == self.owner
    a, b = SessionExecutor(Runtime), SessionExecutor(Runtime)
    try:
        fa, fb = a.submit('barrier', {}), b.submit('barrier', {})
        assert fa.result(4)['owner'] != fb.result(4)['owner']
        futures = [a.submit('echo', {'value': i}) for i in range(4)]
        assert [f.result(2)['value'] for f in futures] == list(range(4))
        assert a.snapshot()['open'] is True
    finally:
        a.close(); b.close()


def test_executor_bounds_queue_and_closes_after_error():
    from firetrace.session_executor import SessionExecutor
    entered, release = threading.Event(), threading.Event()
    class Runtime:
        def execute(self, action, args):
            entered.set(); release.wait(3)
            raise ValueError('test failure')
        def status(self): return {}
        def close(self): pass
    executor = SessionExecutor(Runtime)
    try:
        first = executor.submit('block', {})
        assert entered.wait(1)
        queued = [executor.submit('block', {}) for _ in range(8)]
        with pytest.raises(ValueError, match='session_busy'): executor.submit('block', {})
        release.set()
        with pytest.raises(ValueError, match='test failure'): first.result(2)
    finally:
        release.set(); executor.close()
