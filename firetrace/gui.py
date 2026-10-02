from __future__ import annotations

import os
import queue
import sys
import threading
import tkinter as tk
from tkinter import ttk
from pathlib import Path

from . import launcher


class QueueWriter:
    def __init__(self, q: queue.Queue[str], logfile=None):
        self.q = q
        self.logfile = logfile

    def write(self, text: str) -> int:
        if text:
            self.q.put(text)
            if self.logfile:
                self.logfile.write(text)
                self.logfile.flush()
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
        self.stop_event = threading.Event()
        self.closing = False
        self.restarting = False
        self.protocol("WM_DELETE_WINDOW", self.close_worker)

        frame = ttk.Frame(self, padding=12)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Firetrace Control", font=("Segoe UI", 16, "bold")).pack(anchor="w")

        self.status = tk.StringVar(value="Starting...")
        ttk.Label(frame, textvariable=self.status).pack(anchor="w", pady=(4, 2))

        self.mcp_url = tk.StringVar(
            value=f"http://{os.getenv('FIRETRACE_MCP_HOST', '127.0.0.1')}:{os.getenv('FIRETRACE_MCP_PORT', '8765')}/mcp"
        )
        ttk.Label(frame, textvariable=self.mcp_url).pack(anchor="w", pady=(0, 8))

        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(0, 8))
        ttk.Button(buttons, text="Restart worker", command=self.restart_worker).pack(side="left")
        ttk.Button(buttons, text="Copy MCP URL", command=self.copy_mcp_url).pack(side="left", padx=(8, 0))
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
                if "firetrace local mcp listening" in low:
                    self.status.set("Local MCP active")
                elif "cloudflare wss transport enabled" in low:
                    self.status.set("Connecting to Cloudflare...")
                elif "connecting firetrace agent" in low:
                    self.status.set("Connecting to Cloudflare...")
                elif "cloudflare wss connected" in low:
                    self.status.set("Cloudflare WSS active")
                elif "github polling fallback" in low:
                    self.status.set("GitHub fallback active")
                elif "error:" in low or "disconnected:" in low:
                    self.status.set("Error — see log")
                elif "worker exited" in low:
                    self.status.set("Stopped")
        except queue.Empty:
            pass
        self.after(100, self.drain_logs)

    def _run_worker(self) -> None:
        old_out, old_err = sys.stdout, sys.stderr
        launcher.RUNTIME.mkdir(parents=True, exist_ok=True)
        log_path = launcher.RUNTIME / "worker.log"
        if log_path.exists() and log_path.stat().st_size > 2_000_000:
            log_path.replace(log_path.with_suffix(".previous.log"))
        logfile = log_path.open("a", encoding="utf-8", buffering=1)
        writer = QueueWriter(self.log_queue, logfile)
        sys.stdout = writer
        sys.stderr = writer
        try:
            code = launcher.main(stop_event=self.stop_event)
            self.log_queue.put(f"\nWorker exited with code {code}.\n")
        except Exception as exc:
            self.log_queue.put(f"\nFATAL: {type(exc).__name__}: {exc}\n")
        finally:
            sys.stdout, sys.stderr = old_out, old_err
            logfile.close()

    def start_worker(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            return
        self.status.set("Starting...")
        self.stop_event.clear()
        self.worker_thread = threading.Thread(target=self._run_worker, daemon=True)
        self.worker_thread.start()

    def restart_worker(self) -> None:
        if self.restarting or self.closing:
            return
        self.restarting = True
        self.status.set("Stopping...")
        self.stop_event.set()
        self.after(100, self._finish_restart)

    def _finish_restart(self) -> None:
        if self.closing:
            return
        if self.worker_thread and self.worker_thread.is_alive():
            self.after(100, self._finish_restart)
        else:
            self.restarting = False
            self.start_worker()

    def close_worker(self) -> None:
        self.closing = True
        self.stop_event.set()
        self.status.set("Stopping...")
        self.after(100, self._finish_close)

    def _finish_close(self) -> None:
        if self.worker_thread and self.worker_thread.is_alive():
            self.after(100, self._finish_close)
        else:
            self.destroy()

    def copy_mcp_url(self) -> None:
        try:
            self.clipboard_clear()
            self.clipboard_append(self.mcp_url.get())
            self.update()
            self.status.set("MCP URL copied")
        except Exception as exc:
            self.log_queue.put(f"Copy MCP URL failed: {exc}\n")

    def open_repository(self) -> None:
        try:
            os.startfile(str(launcher.ROOT))
        except Exception as exc:
            self.log_queue.put(f"Open repository failed: {exc}\n")


def main() -> None:
    FiretraceGui().mainloop()


if __name__ == "__main__":
    main()
