"""One Playwright owner thread per session, with bounded serial work."""
from concurrent.futures import Future
from copy import deepcopy
from queue import Queue, Empty, Full
import threading
import time


class SessionExecutor:
    def __init__(self, factory):
        self._queue = Queue(maxsize=8)
        self._lock = threading.Lock()
        self._snapshot = {}
        self._closed = False
        self._ready = Future()
        self._thread = threading.Thread(target=self._run, args=(factory,), daemon=True)
        self._thread.start()
        self._ready.result(timeout=90)

    def _run(self, factory):
        runtime = None
        try:
            runtime = factory()
            self._update(runtime)
            self._ready.set_result(True)
            last_update=time.monotonic()
            while True:
                try: item = self._queue.get(timeout=0.05)
                except Empty:
                    with self._lock:
                        if self._closed: break
                    # Deliver browser events and refresh cached presence on owner thread.
                    poll = getattr(runtime, 'poll', None)
                    if poll:
                        try: poll()
                        except Exception: pass
                    if time.monotonic()-last_update>=1:
                        self._update(runtime); last_update=time.monotonic()
                    continue
                if item is None: break
                action, args, future = item
                if future.set_running_or_notify_cancel():
                    try:
                        result=runtime.execute(action, args)
                        self._update(runtime)
                        future.set_result(result)
                    except Exception as exc:
                        self._update(runtime)
                        future.set_exception(exc)
        except BaseException as exc:
            if not self._ready.done(): self._ready.set_exception(exc)
        finally:
            if runtime:
                try: runtime.close()
                except Exception: pass
            with self._lock: self._closed = True
            while True:
                try: item = self._queue.get_nowait()
                except Empty: break
                if item and not item[2].done(): item[2].set_exception(ValueError('session_closed'))

    def _update(self, runtime):
        try: value = runtime.status()
        except Exception: value = {'open': False}
        with self._lock: self._snapshot = value

    def submit(self, action: str, args: dict) -> Future:
        with self._lock:
            if self._closed: raise ValueError('session_closed')
            result = Future()
            try: self._queue.put_nowait((action, args, result))
            except Full: raise ValueError('session_busy') from None
            return result

    def snapshot(self) -> dict:
        with self._lock: return deepcopy(self._snapshot)

    def close(self):
        with self._lock: self._closed = True
        self._thread.join(timeout=310)
        if self._thread.is_alive(): raise RuntimeError('Session still stopping')
