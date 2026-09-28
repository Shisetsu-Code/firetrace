from __future__ import annotations

import queue
import sys
import threading
import tkinter as tk
from tkinter import ttk
from pathlib import Path

from . import launcher


class QueueWriter:
    def __init__(self, q: queue.Queue[str]):
        self.q = q

    def write(self, text: str) -> int:
        if text:
            self.q.put(text)
        return len(text)

    def flush(self) -> None:
        pass


class FiretraceGui(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Firetrace Control")
        self.geometry("780x540")
        self.after(150, self._bring_to_front)
        self.minsize(650, 420)
        self.log_queue: queue.Queue[str] = queue.Queue()
        self.worker_thread: threading.Thread | None = None

        frame = ttk.Frame(self, padding=12)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Firetrace Control", font=("Segoe UI", 16, "bold")).pack(anchor="w")

        self.status = tk.StringVar(value="Starting...")
        ttk.Label(frame, textvariable=self.status).pack(anchor="w", pady=(4, 8))

        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(0, 8))
        ttk.Button(buttons, text="Restart worker", command=self.restart_worker).pack(side="left")
        ttk.Button(buttons, text="Open repository", command=self.open_repository).pack(side="left", padx=(8, 0))

        self.text = tk.Text(frame, wrap="word", font=("Consolas", 10))
        self.text.pack(fill="both", expand=True)
        self.text.configure(state="disabled")

        self.after(100, self.drain_logs)
        self.start_worker()

    def _bring_to_front(self) -> None:
        try:
            self.deiconify()
            self.lift()
            self.attributes("-topmost", True)
            self.after(800, lambda: self.attributes("-topmost", False))
            self.focus_force()
        except Exception:
            pass

    def append_log(self, text: str) -> None:
        self.text.configure(state="normal")
        self.text.insert("end", text)
        self.text.see("end")
        self.text.configure(state="disabled")

    def drain_logs(self) -> None:
        try:
            while True:
                text = self.log_queue.get_nowait()
                self.append_log(text)
                low = text.lower()
                if "cloudflare wss transport enabled" in low:
                    self.status.set("Connecting to Cloudflare...")
                elif "connecting firetrace agent" in low:
                    self.status.set("Cloudflare WSS active")
                elif "github polling fallback" in low:
                    self.status.set("GitHub fallback active")
                elif "error:" in low or "disconnected:" in low:
                    self.status.set("Error — see log")
        except queue.Empty:
            pass
        self.after(100, self.drain_logs)

    def _run_worker(self) -> None:
        old_out, old_err = sys.stdout, sys.stderr
        writer = QueueWriter(self.log_queue)
        sys.stdout = writer
        sys.stderr = writer
        try:
            code = launcher.main()
            self.log_queue.put(f"\nWorker exited with code {code}.\n")
            self.status.set("Stopped")
        except Exception as exc:
            self.log_queue.put(f"\nFATAL: {type(exc).__name__}: {exc}\n")
            self.status.set("Error — see log")
        finally:
            sys.stdout, sys.stderr = old_out, old_err

    def start_worker(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            return
        self.status.set("Starting...")
        self.worker_thread = threading.Thread(target=self._run_worker, daemon=True)
        self.worker_thread.start()

    def restart_worker(self) -> None:
        self.log_queue.put("\nRestart requested. Close and reopen the app if the current worker is still active.\n")
        if not self.worker_thread or not self.worker_thread.is_alive():
            self.start_worker()

    def open_repository(self) -> None:
        import os
        try:
            os.startfile(str(launcher.ROOT))
        except Exception as exc:
            self.log_queue.put(f"Open repository failed: {exc}\n")


def main() -> None:
    FiretraceGui().mainloop()


if __name__ == "__main__":
    main()
